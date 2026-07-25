#!/usr/bin/env bash
#
# Full local dry run: anvil -> deploy escrow -> boot the server against it ->
# play the scenarios end to end. Everything is torn down on exit.
#
# Uses anvil's published test accounts. Nothing here touches a real chain or a
# real key.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT=$(pwd)

RPC_PORT=${RPC_PORT:-8545}
API_PORT=${API_PORT:-8098}
RPC="http://127.0.0.1:${RPC_PORT}"
BASE="http://127.0.0.1:${API_PORT}"
DB="/tmp/pokeplay-dryrun.db"
CHAIN_ID=31337

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

# Killing the backgrounded subshell is not enough: it spawns tsx, which spawns
# the real node process. Kill the whole descendant tree or the next run trips
# over an orphan still holding the API port.
kill_tree() {
  local pid=$1 child
  [[ -z "$pid" ]] && return 0
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  kill_tree "${SERVER_PID:-}"
  kill_tree "${ANVIL_PID:-}"
  rm -f "$DB" "$DB"-wal "$DB"-shm 2>/dev/null || true
}
trap cleanup EXIT

for p in "$RPC_PORT" "$API_PORT"; do
  if lsof -ti:"$p" >/dev/null 2>&1; then
    echo "port $p is already in use — stop whatever is on it first" >&2
    exit 1
  fi
done

bold "== Compiling contracts"
(cd contracts && forge build >/dev/null)

bold "== Starting anvil on :${RPC_PORT}"
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

bold "== Booting the server against it"
rm -f "$DB" "$DB"-wal "$DB"-shm 2>/dev/null || true
# Derive anvil account #1 (the arbiter) HERE, at repo root — inside the subshell
# below the cwd is server/, so the relative path would not resolve.
ARBITER_KEY=$(node scripts/dry-run/anvil.mjs 1)
(
  cd server
  DB_PATH="$DB" PORT="$API_PORT" CHAIN_ID="$CHAIN_ID" RPC_URL="$RPC" \
  ESCROW_ADDRESS="$ESCROW" \
  STUCK_SETTLEMENT_SECONDS=0 \
  ARBITER_PRIVATE_KEY="$ARBITER_KEY" \
  npx tsx src/index.ts >/tmp/pokeplay-dryrun-server.log 2>&1
) &
SERVER_PID=$!

up=""
for _ in $(seq 1 60); do
  if curl -s -m 1 "$BASE/api/stats" >/dev/null 2>&1; then up=1; break; fi
  sleep 0.5
done
if [[ -z "$up" ]]; then
  echo "server never came up. log:" >&2
  tail -30 /tmp/pokeplay-dryrun-server.log >&2
  exit 1
fi

# The startup guard is the whole point of booting it this way.
if grep -q "domain + arbiter verified" /tmp/pokeplay-dryrun-server.log; then
  echo "  startup guard: domain + arbiter verified on chain"
else
  echo "  ⚠ startup guard did not report a verified domain — check the log" >&2
fi

bold "== Running the scenarios"
RPC_URL="$RPC" CHAIN_ID="$CHAIN_ID" BASE="$BASE" ESCROW_ADDRESS="$ESCROW" \
  node scripts/dry-run/flow.mjs
code=$?

echo
echo "server log: /tmp/pokeplay-dryrun-server.log"
exit $code
