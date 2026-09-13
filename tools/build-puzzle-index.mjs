#!/usr/bin/env node
// Build the static puzzle-retrieval index from the Lichess puzzle database (CC0).
//
//   node tools/build-puzzle-index.mjs            # streams the ~250MB .zst from lichess
//   node tools/build-puzzle-index.mjs file.csv   # or reuse a local csv / csv.zst
//
// Emits puzzles/<theme>/<band>.json shards (top puzzles by popularity per motif ×
// 300-point rating band) plus puzzles/index.json — a few MB total, committed to git
// and served as static files. The app retrieves "structurally similar" positions
// from these shards after a blunder; see index.html's similarPuzzles().
//
// CSV row: PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
// NOTE: the CSV's FEN is the position BEFORE the opponent's setup move — Moves[0] is
// the opponent's move and Moves[1..] is the solution. Shards store the raw form; the
// client applies Moves[0] itself (same convention conversion it does for the live API).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'puzzles');
const URL_ZST = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';

// motifs the app can route a blunder to (folder names = lichess theme slugs)
const THEMES = ['fork','pin','skewer','discoveredAttack','hangingPiece','mate','mateIn1','mateIn2',
  'backRankMate','exposedKing','trappedPiece','endgame','rookEndgame','pawnEndgame','queenEndgame',
  'bishopEndgame','knightEndgame'];
const THEME_SET = new Set(THEMES);
// secondary tags worth keeping on each record (phase + length feed the similarity score)
const KEEP_TAGS = new Set([...THEMES, 'opening','middlegame','oneMove','short','long','crushing','advantage']);

const BANDS = [500, 800, 1100, 1400, 1700];      // band b covers [b, b+300); last runs to 2100
const RATING_MIN = 500, RATING_MAX = 2100;
const PER_SHARD = 200;                            // kept per (theme × band), by popularity
const TRIM_AT = 800;                              // in-memory cap before an interim trim
const MIN_POP = 40, MIN_PLAYS = 60, MAX_RD = 100; // quality floor

const bandOf = r => { let b = BANDS[0]; for (const x of BANDS) if (r >= x) b = x; return b; };

async function* rawChunks(arg) {
  if (arg) { yield* fs.createReadStream(arg); return; }
  console.log('downloading + decompressing', URL_ZST, '…');
  const r = await fetch(URL_ZST);
  if (!r.ok) throw new Error('download failed: HTTP ' + r.status);
  yield* Readable.fromWeb(r.body);
}

// Decode a .zst stream. Lichess compresses with pzstd, which interleaves skippable
// frames (magic 0x184D2A5x, content = byte length of the next data frame) that
// Node's streaming ZstdDecompress rejects — so walk the frames ourselves and
// decompress each data frame whole. A plain single-frame .zst still works too.
async function* zstdDecode(chunks) {
  let buf = Buffer.alloc(0);
  const it = chunks[Symbol.asyncIterator]();
  const need = async n => {
    while (buf.length < n) {
      const { value, done } = await it.next();
      if (done) return false;
      buf = buf.length ? Buffer.concat([buf, value]) : value;
    }
    return true;
  };
  while (true) {
    if (!(await need(4))) return;
    if (((buf.readUInt32LE(0) & 0xFFFFFFF0) >>> 0) === 0x184D2A50) {   // skippable frame
      if (!(await need(8))) throw new Error('truncated skippable frame');
      const sz = buf.readUInt32LE(4);
      if (!(await need(8 + sz))) throw new Error('truncated skippable frame');
      const content = buf.subarray(8, 8 + sz);
      buf = buf.subarray(8 + sz);
      if (sz === 4) {                                                   // pzstd: next frame's size
        const frameLen = content.readUInt32LE(0);
        if (!(await need(frameLen))) throw new Error('truncated zstd frame');
        yield zlib.zstdDecompressSync(buf.subarray(0, frameLen));
        buf = buf.subarray(frameLen);
      }
      continue;
    }
    // no pzstd header: hand the rest to one streaming decompressor (single-frame file)
    const head = buf;
    const src = Readable.from((async function* () {
      yield head;
      for (;;) { const { value, done } = await it.next(); if (done) break; yield value; }
    })());
    yield* src.pipe(zlib.createZstdDecompress());
    return;
  }
}

async function openLines(arg) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    console.error('This Node lacks built-in zstd (need ≥23.8 / 22.15). Either upgrade Node, or:');
    console.error('  brew install zstd');
    console.error(`  curl -L ${URL_ZST} | zstd -d > /tmp/lichess_puzzles.csv`);
    console.error('  node tools/build-puzzle-index.mjs /tmp/lichess_puzzles.csv');
    process.exit(1);
  }
  const stream = (arg && !arg.endsWith('.zst'))
    ? fs.createReadStream(arg)
    : Readable.from(zstdDecode(rawChunks(arg)));
  return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

const shards = new Map();                         // "theme|band" -> [{pop, rec}]
const trim = (arr, n) => { arr.sort((a, b) => b.pop - a.pop); arr.length = Math.min(arr.length, n); };

const t0 = Date.now();
let rows = 0, kept = 0;
const rl = await openLines(process.argv[2]);
for await (const line of rl) {
  rows++;
  if (rows === 1 && line.startsWith('PuzzleId')) continue;
  if (rows % 500000 === 0) console.log(`  …${(rows / 1e6).toFixed(1)}M rows, ${kept} kept, ${((Date.now() - t0) / 1000) | 0}s`);
  const f = line.split(',');
  if (f.length < 8) continue;
  const rating = +f[3], rd = +f[4], pop = +f[5], plays = +f[6];
  if (!(rating >= RATING_MIN && rating < RATING_MAX)) continue;
  if (rd > MAX_RD || pop < MIN_POP || plays < MIN_PLAYS) continue;
  const themes = f[7].split(' ');
  const mine = themes.filter(t => THEME_SET.has(t));
  if (!mine.length) continue;
  const rec = { id: f[0], fen: f[1], moves: f[2].split(' '), rating,
                themes: themes.filter(t => KEEP_TAGS.has(t)) };
  const band = bandOf(rating);
  kept++;
  for (const t of mine) {
    const key = t + '|' + band;
    let arr = shards.get(key);
    if (!arr) shards.set(key, arr = []);
    arr.push({ pop, rec });
    if (arr.length > TRIM_AT) trim(arr, TRIM_AT / 2);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const manifest = { built: new Date().toISOString().slice(0, 10), bands: BANDS, bandWidth: 300, perShard: PER_SHARD, themes: {} };
let total = 0, bytes = 0;
for (const theme of THEMES) {
  const counts = {};
  for (const band of BANDS) {
    const arr = shards.get(theme + '|' + band) || [];
    if (!arr.length) continue;
    trim(arr, PER_SHARD);
    const dir = path.join(OUT, theme);
    fs.mkdirSync(dir, { recursive: true });
    const json = JSON.stringify(arr.map(x => x.rec));
    fs.writeFileSync(path.join(dir, band + '.json'), json);
    counts[band] = arr.length; total += arr.length; bytes += json.length;
  }
  if (Object.keys(counts).length) manifest.themes[theme] = counts;
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(manifest, null, 1));
console.log(`done: ${rows} rows scanned, ${total} puzzles across ${Object.keys(manifest.themes).length} themes → puzzles/ (${(bytes / 1e6).toFixed(1)}MB) in ${((Date.now() - t0) / 1000) | 0}s`);
