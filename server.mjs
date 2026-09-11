// Blunderloop backend — serves the static app AND a cached LLM-commentary endpoint.
// The Anthropic API key lives here (server-side) and never ships to the browser (spec §7).
// Run:  ANTHROPIC_API_KEY=sk-ant-... node server.mjs
// Without a key it still serves the app; the client falls back to rule-based commentary.

import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { Chess } from './lib/chess.js';   // validate transcribed scoresheet moves on a real board

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8777', 10);
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

// Fall back to a local .anthropic_key file if the env var isn't set —
// avoids shell-quoting / invisible-paste headaches. The file is gitignored.
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    const k = readFileSync(path.join(__dirname, '.anthropic_key'), 'utf8').trim();
    if (k) process.env.ANTHROPIC_API_KEY = k;
  } catch {}
}
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const CACHE_FILE = path.join(__dirname, '.commentary-cache.json');

/* ---- accounts: scrypt-hashed passwords, HMAC-signed session cookies, JSON storage ---- */
const USERS_DIR = path.join(__dirname, '.users');
const USERS_FILE = path.join(USERS_DIR, 'users.json');
const STORES_DIR = path.join(USERS_DIR, 'stores');
mkdirSync(STORES_DIR, { recursive: true });
let users = {};
try { if (existsSync(USERS_FILE)) users = JSON.parse(readFileSync(USERS_FILE, 'utf8')); } catch { users = {}; }
const saveUsers = () => writeFileSync(USERS_FILE, JSON.stringify(users, null, 1));
// session-signing secret persists across restarts (gitignored)
const SECRET_FILE = path.join(__dirname, '.session_secret');
if (!existsSync(SECRET_FILE)) writeFileSync(SECRET_FILE, randomBytes(32).toString('hex'));
const SECRET = readFileSync(SECRET_FILE, 'utf8').trim();

const hashPw = (pw, salt) => scryptSync(pw, salt, 64).toString('hex');
const sign = s => createHmac('sha256', SECRET).update(s).digest('hex');
function makeToken(u){ const exp = Date.now() + 30*24*3600*1000; const body = `${u}.${exp}`; return `${body}.${sign(body)}`; }
function verifyToken(tok){
  if (!tok) return null;
  const i = tok.lastIndexOf('.'); if (i < 0) return null;
  const body = tok.slice(0, i), mac = tok.slice(i+1);
  const good = sign(body);
  try { if (!timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null; } catch { return null; }
  const j = body.lastIndexOf('.'); const u = body.slice(0, j); const exp = +body.slice(j+1);
  if (!u || !(exp > Date.now()) || !users[u]) return null;
  return u;
}
function sessionUser(req){
  const m = /(?:^|;\s*)bl_sess=([^;]+)/.exec(req.headers.cookie || '');
  return verifyToken(m ? decodeURIComponent(m[1]) : null);
}
const setSession = (res, tok) => res.setHeader('set-cookie',
  tok ? `bl_sess=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*3600}`
      : 'bl_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
const storeFileOf = u => path.join(STORES_DIR, u.toLowerCase() + '.json');
// crude per-IP throttle on auth endpoints
const authHits = new Map();
function authLimited(ip){
  const now = Date.now(); const h = authHits.get(ip) || { n: 0, reset: now + 600000 };
  if (now > h.reset) { h.n = 0; h.reset = now + 600000; }
  h.n++; authHits.set(ip, h);
  return h.n > 20;
}

/* ---- persistent commentary cache, keyed by (fen | playedUci | model) ---- */
let cache = {};
try { if (existsSync(CACHE_FILE)) cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }
let saveTimer = null;
function persistCache(){ clearTimeout(saveTimer); saveTimer = setTimeout(()=>writeFile(CACHE_FILE, JSON.stringify(cache)).catch(()=>{}), 400); }
const cacheKey = b => `3check7|${MODEL}|${b.fen}|${b.playedUci || b.playedSan || ''}`;
function hash(str){ let h=5381; for(let i=0;i<str.length;i++) h=((h<<5)+h+str.charCodeAt(i))|0; return (h>>>0).toString(36); }

/* ---- Anthropic client (lazy; only if a key is present) ---- */
let client = null;
async function getClient(){
  if (client) return client;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  client = new Anthropic();            // reads ANTHROPIC_API_KEY from env
  return client;
}

const SYSTEM = `You are a warm, encouraging chess coach for a young improving beginner.
You teach ONE habit — the 3-Check the player should run every move, "Why? Me? Safe?":
  • Why?  — Look at the opponent's last move (given below): what did it threaten, and did the player deal with it?
  • Me?   — What was the player's own move FOR (develop, attack, defend, trade)? A move with no job is a piece going for a random stroll.
  • Safe? — After the move, is the player handing over a free piece, or allowing a fork/pin/mate?

You are given the position and a Stockfish analysis. Base EVERYTHING only on those facts — never invent moves or lines. If you are given the opponent's punishing reply, use THAT to explain concretely why the move fails; do not make up a different refutation.
When you are given BOTH continuations (the line after the best move, and the opponent's reply after the played move), contrast them concretely: say what the opponent gets in one and what the player gets in the other, citing only moves that appear in those lines.
When the facts show a concrete tactic, name it in kid-friendly words (free piece, fork, pin, skewer, back-rank mate, discovered attack, trapped piece). If it was just a positional slip, say so simply.

You are told the SEVERITY of the move — it changes your entire framing:
• blunder or mistake — a genuine error; the evaluation confirms it lost real value. Do NOT call it "solid", "fine", "safe", "good", or "a good idea". You may name the move's surface intention, but in the same breath make clear why it falls short. The explanation must agree with the verdict.
• inaccuracy — the move was PLAYABLE; the engine merely has a small preference. Be honest about that: do NOT invent a punishment, do NOT dramatize, do NOT pretend it was an error.

You may be told the KIND of mistake and the game PHASE — adapt to them:
• tactical — a concrete sequence punishes it. This is the most valuable lesson: name the tactic and the punishing moves plainly.
• positional — a quieter judgement slip. Give ONE simple idea in one sentence, and add that this is something to understand, not memorize — never lecture deeply on subtle positional detail.
• opening phase — teach ONLY through the three opening principles: control the center, develop your pieces quickly, keep your king safe. Tie the advice to one of those principles. NEVER give a sequence of opening moves to remember — name at most the single better move. The player should learn ideas, not lines. If you are given the opening's name, mention it naturally once so the player learns what their opening is called.

Output format depends on SEVERITY. No markdown, no move-number dumps, no engine jargon (never say "centipawn").

For a BLUNDER or MISTAKE, walk the 3-Check as EXACTLY four short lines:
Why? <1–2 short sentences: name the opponent's last move and what it was trying to do or threatened; if you are told the opponent had a stronger move, add that their move wasn't best either and what they missed; then whether the played move dealt with the real threat>
Me? <one short sentence: the move's surface intent, and why that plan is not enough here>
Safe? <one short sentence: what the played move gave away or allowed — use the opponent's punishing reply if given>
👉 <one warm sentence naming the ONE check (Why?, Me?, or Safe?) that would have caught this, and what to play or think instead>

For an INACCURACY, reply as EXACTLY two short lines of plain prose — no Why?/Me?/Safe? labels, no 👉:
<line 1: what the played move does, and an honest note that it was okay / playable>
<line 2: what the engine's slight preference accomplishes instead — contrast the two continuations concretely if they are given>

Address the player as "you". One sentence per line. Encouraging, never harsh — a mistake is a free lesson, not a fail.`;

function buildUserText(b){
  const pawns = n => (n>=0?'+':'') + (n/100).toFixed(1);
  const lines = [
    `Position (FEN): ${b.fen}`,
    `You are playing: ${b.mover === 'w' ? 'White' : 'Black'}`,
  ];
  if (b.tag)   lines.push(`Severity of the move: ${b.tag}`);
  if (b.openingName) lines.push(`This opening is known as: ${b.openingName}.`);
  if (b.kind)  lines.push(`Kind of mistake: ${b.kind}`);
  if (b.phase) lines.push(`Game phase: ${b.phase}`);
  if (b.oppLastSan) lines.push(`The opponent's move that just created this position: ${b.oppLastSan}`);
  if (b.oppBestSan) lines.push(`The opponent's move was not best either — the engine preferred ${b.oppBestSan} for them${typeof b.oppLossPawns==='number' ? ` (their move gave back about ${b.oppLossPawns} pawns)` : ''}.`);
  lines.push(
    `The move you played: ${b.playedSan}`,
    `The engine's best move here: ${b.bestSan}`,
  );
  if (b.bestLineSan) lines.push(`Engine's main line after the best move: ${b.bestLineSan}`);
  if (b.refutationLineSan) lines.push(`After the move you played, the opponent's strongest reply (why your move fails): ${b.refutationLineSan}`);
  if (typeof b.evalBeforePawns === 'number' && typeof b.evalAfterPawns === 'number')
    lines.push(`Your evaluation dropped from ${pawns(b.evalBeforePawns*100)} to ${pawns(b.evalAfterPawns*100)} pawns (your perspective) — a swing of about ${(b.lossCp/100).toFixed(1)} pawns.`);
  if (b.mateAfter) lines.push(`Your move allows the opponent a forced checkmate.`);
  lines.push('', b.tag==='inaccuracy'
    ? 'This was only an inaccuracy — reply in the exact two-line honest format (playable move, slight preference).'
    : 'Walk the 3-Check (Why? / Me? / Safe?) for this position, then the 👉 line, in the exact four-line format.');
  return lines.join('\n');
}

// Stream commentary to the client as Server-Sent Events:
//   event: delta  data: {"t": "<chunk>"}   (repeated)
//   event: done   data: {"cached": bool, "model": "..."}
//   event: error  data: {"error": "..."}
const SUMMARY_SYSTEM = `You are a chess coach summarizing a student's recurring weaknesses for the coach.
You are given the student's blunder rate, how their blunders split across game phases, and a list of their worst blunders (the move they played vs. the engine's best move).
Base your summary ONLY on those facts. Identify the 2–3 recurring patterns you actually see (e.g. hangs pieces in the middlegame, misses opponent threats, drops material to knight forks, weak in the opening).
The student is being taught the 3-Check they run every move — "Why?" (spot the opponent's threat), "Me?" (give each move a job), "Safe?" (don't hand over a free piece). For each pattern, say which of these three checks the student most needs to lean on, and give one concrete piece of practice advice.
Write 3–5 short sentences of plain prose addressed to the coach ("Your student…"). No headers, no bullet lists, no engine jargon.`;

function buildSummaryText(b){
  const lines = [
    `Student: ${b.name}`,
    `Overall blunder rate: ${b.rate}% of their moves.`,
    `Blunders by phase — opening: ${b.phases?.opening||0}, middlegame: ${b.phases?.middlegame||0}, endgame: ${b.phases?.endgame||0}.`,
    `Their worst blunders (played → engine's best, pawns lost):`,
    ...(b.blunders||[]).map(x => `  • ${x.playedSan} → ${x.correctSan} (lost ${(x.lossCp/100).toFixed(1)}, ${x.phase})`),
    '',
    'Summarize their recurring weaknesses and give concrete, actionable advice.'
  ];
  return lines.join('\n');
}

async function streamSummary(res, b){
  const key = 'sum|' + MODEL + '|' + hash(JSON.stringify(b));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (cache[key]) { send('delta', { t: cache[key] }); send('done', { cached: true, model: MODEL }); return res.end(); }
  try {
    const anthropic = await getClient();
    const stream = anthropic.messages.stream({
      model: MODEL, max_tokens: 500,
      system: [{ type: 'text', text: SUMMARY_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildSummaryText(b) }],
    });
    let full = '';
    stream.on('text', t => { full += t; send('delta', { t }); });
    const msg = await stream.finalMessage();
    if (msg.stop_reason !== 'refusal') { cache[key] = full.trim(); persistCache(); }
    send('done', { cached: false, model: MODEL }); res.end();
  } catch (e) { send('error', { error: 'LLM request failed: ' + (e?.message || String(e)) }); res.end(); }
}

async function streamCommentary(res, b){
  const key = cacheKey(b);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (cache[key]) { send('delta', { t: cache[key] }); send('done', { cached: true, model: MODEL }); return res.end(); }
  try {
    const anthropic = await getClient();
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 400,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildUserText(b) }],
    });
    let full = '';
    stream.on('text', t => { full += t; send('delta', { t }); });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') { if (!full) send('delta', { t: 'The coach declined to comment on this position.' }); }
    else { const clean = full.trim(); cache[key] = clean; persistCache(); }
    send('done', { cached: false, model: MODEL });
    res.end();
  } catch (e) {
    send('error', { error: 'LLM request failed: ' + (e?.message || String(e)) });
    res.end();
  }
}

/* ---- scoresheet photo → PGN (vision) ---- */
const SHEET_SYSTEM = `You transcribe photos of handwritten chess scoresheets (score book pages) into machine-readable form.
Return ONLY a JSON object — no markdown fences, no prose — shaped exactly like:
{"headers":{"White":"name or ?","Black":"name or ?","Date":"YYYY.MM.DD or ?","Event":"event or ?","Result":"1-0"},
 "moves":["e4","e5","Nf3"],
 "uncertain":[{"n":12,"side":"w","read":"Nf3","alts":["Nf5"]}],
 "notes":"anything odd about the sheet"}
Rules:
- "moves" is one flat array in play order (White's move then Black's, each turn), in standard SAN: pieces K Q R B N, files a-h, ranks 1-8, x for captures, O-O / O-O-O for castling, = for promotions, + / # allowed.
- Read carefully: handwriting confuses 4/9, 1/7, b/6, g/9, B/8, o/0, and kids write castling as 0-0. Use chess sense — the move must be plausible in the game — to disambiguate.
- If the sheet uses descriptive notation (P-K4, NxB), convert it to SAN.
- NEVER skip or stop at an unclear entry — always output your single most plausible reading for every written move and list doubtful ones in "uncertain". Imperfect is fine; every move is verified on a board afterwards and repaired with you.
- Stop at the last written move; NEVER invent moves to finish a game.
- "Result": the sheet's recorded result (1-0, 0-1, 1/2-1/2, a circled winner name); "*" if absent.
- Fill headers from the sheet's name/date/event boxes; "?" when blank.`;

function pgnFrom(headers, moves){
  const h = headers || {};
  const esc = s => String(s ?? '?').replace(/"/g, "'");
  const res = ['1-0','0-1','1/2-1/2','*'].includes(h.Result) ? h.Result : '*';
  const tags = [`[Event "${esc(h.Event)}"]`, `[Date "${esc(h.Date)}"]`, `[White "${esc(h.White)}"]`, `[Black "${esc(h.Black)}"]`, `[Result "${res}"]`];
  let mt=''; for (let i=0;i<moves.length;i++){ if(i%2===0) mt += (i/2+1)+'. '; mt += moves[i]+' '; }
  return tags.join('\n') + '\n\n' + mt.trim() + ' ' + res + '\n';
}
function validateMoves(moves){
  const c = new Chess();
  for (let i=0;i<moves.length;i++){
    if (!c.move(moves[i], { sloppy:true })) return { ok:false, at:i, fen:c.fen() };
  }
  return { ok:true, at:moves.length };
}
function parseModelJson(text){
  let js = String(text||'').trim().replace(/^```(?:json)?/,'').replace(/```$/,'').trim();
  const s = js.indexOf('{'), e = js.lastIndexOf('}');
  if (s >= 0 && e > s) js = js.slice(s, e+1);
  try { return JSON.parse(js); } catch { return null; }
}

function lev(a,b){
  const m=[...Array(a.length+1)].map((_,i)=>[i]);
  for(let j=1;j<=b.length;j++) m[0][j]=j;
  for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++)
    m[i][j]=Math.min(m[i-1][j]+1, m[i][j-1]+1, m[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return m[a.length][b.length];
}
const movetextOf = moves => moves.map((m,i)=>(i%2===0?(i/2+1)+'. ':'')+m).join(' ');

// ask the model to re-read ONE unclear entry, constrained to the position's legal moves
async function repairMove(anthropic, images, moves, idx, fen, legal){
  const content = [
    ...images.map(im => ({ type:'image', source:{ type:'base64', media_type: im.media_type||'image/jpeg', data: im.data } })),
    { type:'text', text:
`Transcription so far: ${movetextOf(moves.slice(0, idx))}
Half-move ${idx+1} — ${idx%2===0?'White':'Black'}'s move ${Math.floor(idx/2)+1} on the sheet — was read as "${moves[idx]}", but that move is ILLEGAL in the position (FEN: ${fen}).
The legal moves here are: ${legal.join(' ')}
Look at that entry in the photo again (remember 4/9, 1/7, b/6, g/9, B/8 confusions). Reply with ONLY one move in SAN, chosen from the legal list: the best match to the handwriting, or if truly unreadable, the most natural chess move.` },
  ];
  const msg = await anthropic.messages.create({ model: MODEL, max_tokens: 12, messages:[{role:'user',content}] });
  return (msg.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('').trim().split(/\s+/)[0];
}

async function handleScoresheet(res, b){
  const anthropic = await getClient();
  const content = [
    ...b.images.map(im => ({ type:'image', source:{ type:'base64', media_type: im.media_type||'image/jpeg', data: im.data } })),
    { type:'text', text:'Transcribe this scoresheet into the JSON format.' },
  ];
  const msgs = [{ role:'user', content }];
  let parsed = null, lastText = '';
  for (let attempt=0; attempt<2; attempt++){
    const msg = await anthropic.messages.create({
      model: MODEL, max_tokens: 3000,
      system: [{ type:'text', text: SHEET_SYSTEM, cache_control:{ type:'ephemeral' } }],
      messages: msgs,
    });
    lastText = (msg.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');
    parsed = parseModelJson(lastText);
    if (parsed && Array.isArray(parsed.moves)) break;
    if (attempt===0) msgs.push({role:'assistant',content:lastText},{role:'user',content:'That was not the required JSON. Reply with ONLY the JSON object.'});
  }
  if (!parsed || !Array.isArray(parsed.moves) || !parsed.moves.length){
    res.writeHead(422, {'content-type':'application/json'});
    return res.end(JSON.stringify({ error:'Could not read a chess game from the photo(s). Try a sharper, straight-on photo with good light.' }));
  }
  let moves = parsed.moves.slice(0, 300).map(m=>String(m||'').trim()).filter(Boolean);
  // conjecture-and-continue repair: every illegal reading is replaced by the most plausible
  // LEGAL move (model re-reads the photo; string-similarity fallback), flagged for review.
  const conjectured = [];
  const norm = s => String(s||'').replace(/[+#]/g,'');
  let visionRepairs = 0;
  for (let guard=0; guard<8; guard++){
    const v = validateMoves(moves);
    if (v.ok) break;
    const c = new Chess();
    for (let i=0;i<v.at;i++) c.move(moves[i], {sloppy:true});
    const legal = c.moves();
    if (!legal.length){ moves = moves.slice(0, v.at); break; }   // game already over on the board
    let pick = null;
    if (visionRepairs < 4){ visionRepairs++; try{ pick = await repairMove(anthropic, b.images, moves, v.at, v.fen, legal); }catch(e){} }
    let chosen = legal.find(L => norm(L)===norm(pick));
    if (!chosen) chosen = legal.slice().sort((x,y)=>lev(norm(x),norm(moves[v.at]))-lev(norm(y),norm(moves[v.at])))[0];
    conjectured.push({ n:Math.floor(v.at/2)+1, side:v.at%2===0?'white':'black', read:moves[v.at], used:chosen });
    moves[v.at] = chosen;
  }
  const v = validateMoves(moves);
  const warnings = [];
  if (!v.ok){
    warnings.push(`Could not repair the game past half-move ${v.at} — imported the verified part; the sheet may be misread around move ${Math.floor(v.at/2)+1}. Unverified rest: ${moves.slice(v.at).join(' ')}`);
    moves = moves.slice(0, v.at);
  }
  if (conjectured.length)
    warnings.push('Conjectured moves — please verify and correct in the PGN box if wrong: ' +
      conjectured.map(cj=>`move ${cj.n} (${cj.side}): sheet read "${cj.read}" → used "${cj.used}"`).join('; '));
  if (Array.isArray(parsed.uncertain) && parsed.uncertain.length)
    warnings.push('Uncertain readings — double-check: ' + parsed.uncertain.map(u=>`move ${u.n}${u.side==='b'?' (black)':' (white)'}: ${u.read}${u.alts&&u.alts.length?` (or ${u.alts.join('/')})`:''}`).join('; '));
  if (parsed.notes && String(parsed.notes).trim() && !/^(none|nothing|n\/a|-)?$/i.test(String(parsed.notes).trim())) warnings.push(String(parsed.notes));
  res.writeHead(200, {'content-type':'application/json'});
  res.end(JSON.stringify({ pgn: pgnFrom(parsed.headers, moves), moves: moves.length, fullyValid: v.ok, conjectured, warnings }));
}

/* ---- static file serving ---- */
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.wasm':'application/wasm', '.json':'application/json', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.map':'application/json' };

function readBody(req, maxSize = 1e6){
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', c => { size += c.length; if (size > maxSize) { reject(new Error('body too large')); req.destroy(); } data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ llm: HAS_KEY, model: MODEL, auth: true, user: sessionUser(req) }));
    }

    /* ---- accounts & per-user cloud store ---- */
    const json = (code, obj) => { res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/api/register' && req.method === 'POST') {
      if (authLimited(req.socket.remoteAddress)) return json(429, { error: 'Too many attempts — wait a few minutes.' });
      let b; try { b = JSON.parse(await readBody(req)); } catch { return json(400, { error: 'bad json' }); }
      const u = String(b?.username || '').trim();
      const pw = String(b?.password || '');
      if (!/^[a-zA-Z0-9_-]{3,20}$/.test(u)) return json(400, { error: 'Username: 3–20 letters, digits, - or _' });
      if (pw.length < 8) return json(400, { error: 'Password must be at least 8 characters.' });
      const key = u.toLowerCase();
      if (users[key]) return json(409, { error: 'That username is taken.' });
      const salt = randomBytes(16).toString('hex');
      users[key] = { name: u, salt, hash: hashPw(pw, salt), created: Date.now() };
      saveUsers();
      setSession(res, makeToken(key));
      return json(200, { user: key });
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (authLimited(req.socket.remoteAddress)) return json(429, { error: 'Too many attempts — wait a few minutes.' });
      let b; try { b = JSON.parse(await readBody(req)); } catch { return json(400, { error: 'bad json' }); }
      const key = String(b?.username || '').trim().toLowerCase();
      const rec = users[key];
      const candidate = rec ? hashPw(String(b?.password || ''), rec.salt) : hashPw('x', '00');
      const ok = rec && timingSafeEqual(Buffer.from(candidate), Buffer.from(rec ? rec.hash : candidate));
      if (!ok) return json(401, { error: 'Wrong username or password.' });
      setSession(res, makeToken(key));
      return json(200, { user: key });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') { setSession(res, null); return json(200, { ok: true }); }
    if (url.pathname === '/api/me') return json(200, { user: sessionUser(req) });
    if (url.pathname === '/api/store') {
      const u = sessionUser(req);
      if (!u) return json(401, { error: 'not signed in' });
      const f = storeFileOf(u);
      if (req.method === 'GET') {
        try { return json(200, { store: existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null }); }
        catch { return json(200, { store: null }); }
      }
      if (req.method === 'PUT') {
        let body; try { body = await readBody(req, 15e6); } catch { return json(413, { error: 'store too large' }); }
        try { JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
        await writeFile(f, body);
        return json(200, { ok: true, bytes: body.length });
      }
    }

    if (url.pathname === '/api/commentary' && req.method === 'POST') {
      if (!HAS_KEY) { res.writeHead(503, {'content-type':'application/json'}); return res.end(JSON.stringify({ error: 'No ANTHROPIC_API_KEY configured on the server.' })); }
      let b;
      try { b = JSON.parse(await readBody(req)); } catch { res.writeHead(400); return res.end('bad json'); }
      if (!b || !b.fen || !b.bestSan || !b.playedSan) { res.writeHead(400, {'content-type':'application/json'}); return res.end(JSON.stringify({ error: 'missing fen/bestSan/playedSan' })); }
      return streamCommentary(res, b);
    }

    if (url.pathname === '/api/scoresheet' && req.method === 'POST') {
      if (!HAS_KEY) { res.writeHead(503, {'content-type':'application/json'}); return res.end(JSON.stringify({ error: 'No ANTHROPIC_API_KEY configured on the server.' })); }
      let b; try { b = JSON.parse(await readBody(req, 30e6)); } catch { res.writeHead(400, {'content-type':'application/json'}); return res.end(JSON.stringify({ error:'bad json (photos too large?)' })); }
      if (!b || !Array.isArray(b.images) || !b.images.length) { res.writeHead(400, {'content-type':'application/json'}); return res.end(JSON.stringify({ error:'missing images' })); }
      if (b.images.length > 4) { res.writeHead(400, {'content-type':'application/json'}); return res.end(JSON.stringify({ error:'max 4 photos per game' })); }
      try { return await handleScoresheet(res, b); }
      catch (e) { res.writeHead(500, {'content-type':'application/json'}); return res.end(JSON.stringify({ error:'Scoresheet read failed: ' + (e?.message || String(e)) })); }
    }

    if (url.pathname === '/api/coach-summary' && req.method === 'POST') {
      if (!HAS_KEY) { res.writeHead(503, {'content-type':'application/json'}); return res.end(JSON.stringify({ error: 'No ANTHROPIC_API_KEY configured on the server.' })); }
      let b; try { b = JSON.parse(await readBody(req)); } catch { res.writeHead(400); return res.end('bad json'); }
      if (!b || !b.name || !Array.isArray(b.blunders)) { res.writeHead(400, {'content-type':'application/json'}); return res.end(JSON.stringify({ error: 'missing name/blunders' })); }
      return streamSummary(res, b);
    }

    // static files
    let p = decodeURIComponent(url.pathname);
    if (p === '/' ) p = '/index.html';
    const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(__dirname, safe);
    if (!file.startsWith(__dirname) || safe === '/server.mjs' ||
        safe.includes('.commentary-cache') || safe.includes('.anthropic_key') ||
        safe.includes('.session_secret') || safe.includes('.users')) { res.writeHead(404); return res.end('not found'); }
    try {
      const buf = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(buf);
    } catch { res.writeHead(404); return res.end('not found'); }
  } catch (e) {
    res.writeHead(500); res.end('server error');
  }
});

// default: this machine only. Set HOST=0.0.0.0 to open it to your home wifi
// (so a tablet can use http://<this-mac's-LAN-IP>:8777 with the same accounts).
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`\nBlunderloop → http://localhost:${PORT}/index.html`);
  console.log(HAS_KEY ? `AI commentary: ON  (model: ${MODEL})` : `AI commentary: OFF  (set ANTHROPIC_API_KEY to enable)`);
  console.log('Ctrl-C to stop.\n');
});
