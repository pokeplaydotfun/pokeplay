#!/usr/bin/env bash
#
# End-to-end dry run for the PAID TOURNAMENT path: anvil -> deploy the pool ->
# boot the game server against it -> drive a two-player paid tournament through
# the server and the contract together (create, on-chain join, battle, settle,
# withdraw). Everything is torn down on exit.
#
# No real chain, no real key. The arbiter is anvil's throwaway key, which is also
# what the server signs with, so the server's signature satisfies the pool.
set -euo pipefail

cd "$(dirname "$0")/../.."

RPC_PORT=${RPC_PORT:-8545}
API_PORT=${API_PORT:-8098}
RPC="http://127.0.0.1:${RPC_PORT}"
BASE="http://127.0.0.1:${API_PORT}"
DB="/tmp/pokeplay-tourrun.db"
CHAIN_ID=31337

# anvil's deterministic keys: account #0 is the deployer/admin, and this arbiter
# key matches KEYS.arbiter in lib.mjs (so the pool's arbiter == the server's).
# anvil account #1 (the arbiter), derived rather than hard-coded — see anvil.mjs
ARBITER_KEY=$(node scripts/dry-run/anvil.mjs 1)
ADMIN_ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

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

bold "== Deploying PokePlayTournamentPool"
POOL=$(RPC_URL="$RPC" CHAIN_ID="$CHAIN_ID" node scripts/dry-run/tournament-deploy.mjs)
echo "  address  $POOL"

bold "== Booting the server against it (paid tournaments enabled)"
rm -f "$DB" "$DB"-wal "$DB"-shm 2>/dev/null || true
(
  cd server
  DB_PATH="$DB" PORT="$API_PORT" CHAIN_ID="$CHAIN_ID" RPC_URL="$RPC" \
  TOURNAMENT_POOL_ADDRESS="$POOL" \
  ARBITER_PRIVATE_KEY="$ARBITER_KEY" \
  ADMIN_ADDRESSES="$ADMIN_ADDR" \
  STUCK_SETTLEMENT_SECONDS=0 \
  DEV_LOGIN=0 \
  npx tsx src/index.ts >/tmp/pokeplay-tourrun-server.log 2>&1
) &
SERVER_PID=$!

up=""
for _ in $(seq 1 60); do
  if curl -s -m 1 "$BASE/api/stats" >/dev/null 2>&1; then up=1; break; fi
  sleep 0.5
done
if [[ -z "$up" ]]; then
  echo "server never came up. log:" >&2
  tail -30 /tmp/pokeplay-tourrun-server.log >&2
  exit 1
fi

if grep -q "pool domain + arbiter verified" /tmp/pokeplay-tourrun-server.log; then
  echo "  startup guard: pool domain + arbiter verified on chain"
else
  echo "  ⚠ startup guard did not report a verified pool — check the log" >&2
fi

bold "== Running the paid-tournament scenario"
RPC_URL="$RPC" CHAIN_ID="$CHAIN_ID" BASE="$BASE" POOL_ADDRESS="$POOL" \
  node scripts/dry-run/tournament-server-flow.mjs
code=$?

echo
echo "server log: /tmp/pokeplay-tourrun-server.log"
exit $code
