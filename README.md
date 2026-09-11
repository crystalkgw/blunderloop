# Blunderloop

**Train on the mistakes you actually make.** A client-side chess trainer that ingests
your own games, finds your blunders with Stockfish, and drills those *exact* positions
back to you on a spaced-repetition schedule until they stop happening.

This is the MVP from `PRODUCT_SPEC.md` — the closed loop the incumbents don't have
(Aimchess drills themes, Chessable drills courses; nobody drills *your* blunder positions
on an SRS schedule).

## Run it

One command — installs deps on first run, serves the app, opens it:

```bash
cd ChessLossTrainer && ./run.sh
```

Then open <http://localhost:8777/index.html>. Everything (games, analysis, puzzles, SRS
progress) lives in your browser's `localStorage`; the only server-side state is a
commentary cache.

It must be served over HTTP (ES modules + the Stockfish Web Worker don't run from a
`file://` page). The Node server (`server.mjs`) serves the static app **and** the AI
endpoint. If you only want the free client-side loop and no AI, any static server works
too — `python3 -m http.server 8777` — the app just hides the AI buttons.

## AI coach (optional LLM layer)

The "✨ Explain with AI" buttons in **Review** and **Train** turn a rule-based note into a
real plain-language explanation ("you walked into a knight fork…"). The Anthropic key
stays **server-side** (spec §7) — it never ships to the browser.

To enable it, set a key before starting:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
./run.sh
```

- **Off by default.** With no key, `/api/health` reports `llm:false` and the app runs the
  free client-side loop with rule-based commentary only — no AI buttons.
- **Model:** defaults to `claude-opus-4-8`. Override with `ANTHROPIC_MODEL=claude-haiku-4-5`
  (cheaper/faster) or `claude-sonnet-5` for a middle ground.
- **Streamed** token-by-token over Server-Sent Events, so the coach types out live.
- **Cached** per `(FEN, move)` in `.commentary-cache.json` — the same blunder positions
  recur, so repeat explanations are free and instant (spec §7). Rendered explanations are
  also cached client-side in `localStorage`.
- Two SSE endpoints: `POST /api/commentary` (per-move explanation) and
  `POST /api/coach-summary` (a paragraph summarizing a student's recurring weaknesses,
  shown in the Coach view). Both emit `event: delta` / `event: done` / `event: error`.

## What it does (MVP scope, all built)

1. **Import** — Lichess username, Chess.com username, or pasted/uploaded PGN. Auto-detects
   the color you played, keeps only your **losses**, de-dupes on re-import. Both game APIs
   are CORS-open so it calls them straight from the browser. Try **Load demo game** first.
2. **Analyze** — Stockfish 10 (WASM) evaluates every position at depth 12, computes
   centipawn loss per move, and tags **blunder ≥3.0 / mistake ≥1.2 / inaccuracy ≥0.5**.
3. **Review** — step through the loss on an interactive board with an eval bar, a
   colour-coded move list (`??`/`?`/`?!`), and a plain-language note on each mistake.
4. **Train** — every blunder becomes a puzzle (the position *before* you went wrong; solve
   for the engine's move). **Leitner SRS** with intervals `[0,1,3,7,16,35]` days: right →
   advance a box, wrong → back to box 1 and re-drilled this session.
5. **Stats** — blunder rate, blunders/mistakes by game phase (opening / middlegame /
   endgame), and a per-game table.
6. **Coach** — add students, import each student's games (kept separate from yours and
   from each other), see their weakness report (KPIs, blunders-by-phase, top recurring
   blunders, and an optional AI coach summary), and **Drill as \<student\>** — the Train
   view scoped to that student's own blunders with its own spaced-repetition schedule.

## How it's built

- **`index.html`** — the whole app: vanilla JS (ES module), hand-rolled CSS board, no
  framework.
- **`lib/chess.js`** — chess.js 0.13.4 (classic API): PGN parsing, move gen, SAN/FEN,
  terminal detection.
- **`lib/stockfish/`** — Stockfish 10.0.2 JS/WASM build, run as a Web Worker over UCI.
  The engine handshake, terminal-position handling (checkmate/stalemate never send
  `bestmove`, so those are detected in-JS and skipped), and per-request safety timeout all
  follow the spec's validated pattern.
- **`server.mjs`** — a ~150-line zero-framework Node server: serves the static app and the
  cached `/api/commentary` endpoint (via `@anthropic-ai/sdk`). The commentary component is
  designed so the rule-based string and the LLM string are interchangeable (spec §5.3) —
  the app degrades gracefully to rule-based when no key/backend is present.

Data model (games / per-move analysis / puzzles) matches `PRODUCT_SPEC.md §11`.

## Deploying

**Static (free tier for everyone):** it's static files — GitHub Pages / Netlify / Vercel as-is
(live at <https://crystalkgw.github.io/blunderloop/>). Stockfish 10 needs **no** COOP/COEP
headers. On a static host the AI/login features hide themselves automatically.

**Full backend (accounts + AI + subscriptions):** deploy `server.mjs` with `render.yaml`
(Render → New + → Blueprint → this repo), then set three env vars in the dashboard:
`ANTHROPIC_API_KEY`, `ADMIN_USERS` (your username — unlimited AI + admin endpoints), and
`SUBSCRIBE_URL` (your Stripe Payment Link).

### Accounts & the subscription model

- Registration/login: scrypt-hashed passwords, signed HttpOnly session cookies, per-user
  cloud sync of the whole library (merge-by-id, multi-device).
- **AI free tier:** each account gets AI coaching on its first **5 games** (`FREE_AI_GAMES`);
  re-explaining a game already coached never costs a credit. After that, AI endpoints return
  402 with your `SUBSCRIBE_URL`, and the app shows a Subscribe link.
- **Activating a subscriber:** after someone pays, an admin flips them on:
  `POST /api/admin/subscribe {"username":"...","subscribed":true}` (see also
  `GET /api/admin/users` for usage). A Stripe webhook can automate this later.
- Everyone (subscribers too) is capped at `AI_DAILY_CAP` (300) AI calls/day.
- A server bound to `127.0.0.1` (the default, your own machine) skips all gating;
  any public binding (`HOST=0.0.0.0`) enforces it. For home-LAN mode, list your
  family in `ADMIN_USERS` to keep them unlimited.

## Roadmap (post-MVP, from the spec)

- ~~**LLM commentary**~~ — **done**: rule-based note + optional streamed AI explanation,
  key held server-side, cached per position.
- ~~**Coach view**~~ — **done**: multi-student mode with per-student weakness reports,
  isolated data, and student-scoped drilling. The clearest monetization path.
- Tactics-theme tagging (fork / pin / back-rank) to power "you keep falling for forks".
- Rating-adaptive thresholds and puzzle difficulty.
- Accounts + cloud sync (replace localStorage) and a real coach↔student handoff (today
  the coach imports on the student's behalf, all in one browser).
