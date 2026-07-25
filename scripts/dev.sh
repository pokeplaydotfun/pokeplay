#!/usr/bin/env bash
#
# Starts the battle API and the Vite frontend together, and shuts both down
# when you Ctrl-C. Running them separately is the usual cause of
# "Could not load the Pokédex — Failed to fetch": the frontend is up but
# nothing is listening on the API port.
#
#   ./scripts/dev.sh            # normal
#   DEV_LOGIN=1 ./scripts/dev.sh   # adds the wallet-free test accounts
#
set -euo pipefail

cd "$(dirname "$0")/.."

API_PORT="${PORT:-8090}"
WEB_PORT="${WEB_PORT:-5173}"

if [ ! -d server/node_modules ]; then
  echo "Installing server dependencies…"
  (cd server && npm install)
fi
if [ ! -d node_modules ]; then
  echo "Installing frontend dependencies…"
  npm install
fi

# Refuse to start on a busy port rather than silently failing to bind and
# leaving an older server answering with stale code.
for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -ti:"$port" >/dev/null 2>&1; then
    echo "Port $port is already in use. Free it first:"
    echo "  lsof -ti:$port | xargs kill -9"
    exit 1
  fi
done

pids=()
cleanup() {
  echo
  echo "Shutting down…"
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting battle API on :$API_PORT"
(cd server && PORT="$API_PORT" npm start) &
pids+=($!)

# Wait for the API to answer before starting the frontend, so the first page
# load does not race it.
for _ in $(seq 1 40); do
  if curl -sf -m 1 "http://127.0.0.1:$API_PORT/api/stats" >/dev/null 2>&1; then
    echo "API is up."
    break
  fi
  sleep 0.5
done

if ! curl -sf -m 1 "http://127.0.0.1:$API_PORT/api/stats" >/dev/null 2>&1; then
  echo "The API did not come up. Check the output above."
  exit 1
fi

echo "Starting frontend on :$WEB_PORT"
npm run dev -- --port "$WEB_PORT" &
pids+=($!)

wait
