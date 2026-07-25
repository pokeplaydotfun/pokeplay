#!/usr/bin/env bash
#
# Browser pass: anvil -> deploy escrow + tournament pool -> server -> build the
# frontend against them -> serve it -> drive a real Chromium through the claim
# flow and the paid-tournament flow.
#
# Separate from run.sh because it builds and serves the frontend, which is slow
# and only needed for the UI checks.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT=$(pwd)

RPC_PORT=${RPC_PORT:-8545}
API_PORT=${API_PORT:-8098}
SITE_PORT=${SITE_PORT:-4173}
RPC="http://127.0.0.1:${RPC_PORT}"
BASE="http://127.0.0.1:${API_PORT}"
SITE="http://127.0.0.1:${SITE_PORT}"
DB="/tmp/pokeplay-uirun.db"
CHAIN_ID=31337

# anvil's deterministic account #0 is the deployer, and the only tournament
# admin here — the browser pass posts a paid tournament as this wallet. The
# arbiter key matches KEYS.arbiter in lib.mjs, so the signature the server hands
# the champion is one the pool accepts.
# anvil account #1 (the arbiter), derived rather than hard-coded — see anvil.mjs
ARBITER_KEY=$(node scripts/dry-run/anvil.mjs 1)
ADMIN_ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

# Killing the backgrounded subshell is not enough: it spawns tsx/vite, which
# spawn the real node processes. Kill the whole descendant tree or the next run
# trips over an orphan still holding a port.
kill_tree() {
  local pid=$1 child
  [[ -z "$pid" ]] && return 0
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  kill_tree "${SITE_PID:-}"
  kill_tree "${SERVER_PID:-}"
  kill_tree "${ANVIL_PID:-}"
  rm -f "$DB" "$DB"-wal "$DB"-shm 2>/dev/null || true
}
trap cleanup EXIT

for p in "$RPC_PORT" "$API_PORT" "$SITE_PORT"; do
  if lsof -ti:"$p" >/dev/null 2>&1; then
    echo "port $p is already in use — stop whatever is on it first" >&2
    exit 1
  fi
done

bold "== Compiling contracts"
(cd contracts && forge build >/dev/null)

bold "== Starting anvil"
anvil --port "$RPC_PORT" --chain-id "$CHAIN_ID" --silent &
ANVIL_PID=$!
for _ in $(seq 1 40); do
  curl -s -m 1 -X POST "$RPC" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' >/dev/null 2>&1 && break
  sleep 0.25
done

bold "== Deploying PokePlayEscrow"
ESCROW=$(RPC_URL="$RPC" CHAIN_ID="$CHAIN_ID" node scripts/dry-run/deploy.mjs)
echo "  address  $ESCROW"

bold "== Deploying PokePlayTournamentPool"
POOL=$(RPC_URL="$RPC" CHAIN_ID="$CHAIN_ID" node scripts/dry-run/tournament-deploy.mjs)
echo "  address  $POOL"

bold "== Booting the server"
rm -f "$DB" "$DB"-wal "$DB"-shm 2>/dev/null || true
(
  cd server
  DB_PATH="$DB" PORT="$API_PORT" CHAIN_ID="$CHAIN_ID" RPC_URL="$RPC" \
  ESCROW_ADDRESS="$ESCROW" \
  TOURNAMENT_POOL_ADDRESS="$POOL" \
  ADMIN_ADDRESSES="$ADMIN_ADDR" \
  RECONNECT_SECONDS=10 \
  ARBITER_PRIVATE_KEY="$ARBITER_KEY" \
  npx tsx src/index.ts >/tmp/pokeplay-uirun-server.log 2>&1
) &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -s -m 1 "$BASE/api/stats" >/dev/null 2>&1 && break
  sleep 0.5
done

bold "== Building the frontend against that escrow + pool"
VITE_CHAIN_ID="$CHAIN_ID" \
VITE_RPC_URL="$RPC" \
VITE_ESCROW_ADDRESS="$ESCROW" \
VITE_TOURNAMENT_POOL_ADDRESS="$POOL" \
VITE_API_BASE="$BASE" \
npx vite build >/dev/null

bold "== Serving it on :${SITE_PORT}"
npx vite preview --port "$SITE_PORT" --strictPort --host 127.0.0.1 \
  >/tmp/pokeplay-uirun-site.log 2>&1 &
SITE_PID=$!
for _ in $(seq 1 40); do
  curl -s -m 1 "$SITE" >/dev/null 2>&1 && break
  sleep 0.5
done

bold "== Driving the browser"
RPC_URL="$RPC" CHAIN_ID="$CHAIN_ID" BASE="$BASE" SITE="$SITE" \
ESCROW_ADDRESS="$ESCROW" POOL_ADDRESS="$POOL" \
  node scripts/dry-run/ui.mjs
code=$?

echo
echo "server log: /tmp/pokeplay-uirun-server.log"
exit $code
