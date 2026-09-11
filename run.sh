#!/usr/bin/env bash
# Serve Blunderloop (static app + optional AI-commentary backend) and open it.
# Set ANTHROPIC_API_KEY first to enable the "Explain with AI" coach.
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund
PORT="${PORT:-8777}"
( sleep 1.2 && open "http://localhost:$PORT/index.html" ) >/dev/null 2>&1 &
PORT="$PORT" exec node server.mjs
