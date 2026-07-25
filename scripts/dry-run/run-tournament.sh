#!/usr/bin/env bash
#
# Dry run for PokePlayTournamentPool: deploy the real compiled bytecode to a
# local node and drive the whole lifecycle with real transactions and a real
# arbiter signature — create, joins, settle, withdraw, timeout refund, cancel.
#
# No game server is involved (server wiring is the next step); the arbiter
# signature is produced by the arbiter key directly, exactly as the server will.
#
#   ./run-tournament.sh          # fresh anvil
#   FORK=1 ./run-tournament.sh   # against a fork of Robinhood mainnet
#
# In FORK mode nothing can touch mainnet: anvil forks read-only and every write
# lands on the throwaway local fork. Robinhood's L2 fee is not modelled on a
# fork, so FORK mode runs zero-gas and the flow tops accounts up before each tx
# (see lib.mjs). The pool has no mainnet deployment yet, so even FORK mode
# deploys fresh — proving it deploys and runs against real chain state.
set -euo pipefail

cd "$(dirname "$0")/../.."

RPC_PORT=${RPC_PORT:-8545}
RPC="http://127.0.0.1:${RPC_PORT}"

FORK=${FORK:-0}
FORK_URL=${FORK_URL:-https://rpc.mainnet.chain.robinhood.com}

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

kill_tree() {
  local pid=$1 child
  [[ -z "$pid" ]] && return 0
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() { kill_tree "${ANVIL_PID:-}"; }
trap cleanup EXIT

if lsof -ti:"$RPC_PORT" >/dev/null 2>&1; then
  echo "port $RPC_PORT is already in use — stop whatever is on it first" >&2
  exit 1
fi

bold "== Compiling contracts"
(cd contracts && forge build >/dev/null)

if [[ "$FORK" == "1" ]]; then
  CHAIN_ID=${CHAIN_ID:-4663}
  bold "== Forking ${FORK_URL} on :${RPC_PORT} (zero-gas, see lib.mjs)"
  anvil --port "$RPC_PORT" --fork-url "$FORK_URL" --gas-price 0 --base-fee 0 --silent &
  ANVIL_PID=$!
else
  CHAIN_ID=31337
  bold "== Starting anvil on :${RPC_PORT}"
  anvil --port "$RPC_PORT" --chain-id "$CHAIN_ID" --silent &
  ANVIL_PID=$!
fi

for _ in $(seq 1 80); do
  curl -s -m 2 -X POST "$RPC" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' >/dev/null 2>&1 && break
  sleep 0.5
done
echo "  at block $(cast block-number --rpc-url "$RPC" 2>/dev/null || echo '?')"

bold "== Deploying PokePlayTournamentPool"
POOL=$(RPC_URL="$RPC" CHAIN_ID="$CHAIN_ID" node scripts/dry-run/tournament-deploy.mjs)
echo "  address  $POOL"

bold "== Running the scenarios"
RPC_URL="$RPC" CHAIN_ID="$CHAIN_ID" POOL_ADDRESS="$POOL" FORK="$FORK" \
  node scripts/dry-run/tournament-flow.mjs
exit $?
