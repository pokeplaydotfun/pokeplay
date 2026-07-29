#!/usr/bin/env bash
#
# The dry run, against a FORK of Robinhood mainnet and the REAL deployed escrow.
#
# `run.sh` deploys a fresh contract and proves the code works. This proves the
# DEPLOYMENT works: same bytecode, same constructor args, same accrued state,
# same chain id — the thing that actually holds people's money.
#
# It is read-only with respect to mainnet. Every write lands on the local fork,
# which is destroyed on exit. No key with real funds is used or needed: the
# owner is impersonated by anvil, and the arbiter is repointed (on the fork
# only) at anvil's throwaway key so the local server can sign.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT=$(pwd)

RPC_PORT=${RPC_PORT:-8545}
API_PORT=${API_PORT:-8098}
RPC="http://127.0.0.1:${RPC_PORT}"
BASE="http://127.0.0.1:${API_PORT}"
DB="/tmp/pokeplay-forkrun.db"

FORK_URL=${FORK_URL:-https://rpc.mainnet.chain.robinhood.com}
CHAIN_ID=${CHAIN_ID:-4663}
ESCROW=${ESCROW_ADDRESS:-0xdE1405268a4194853573b5cF4270CaAEDaeCdAA0}

# Checked against what the chain actually reports — see fork-prep.mjs.
# Roles were ROTATED on 2026-07-29: owner moved to the cold wallet, treasury to the hot
# worker (previously both were the deployer 0x2fD76b95…2aB6). See contracts/ROTATE-DEV-WALLET.md.
EXPECT_OWNER=${EXPECT_OWNER:-0x699ff0E24a5de0386d332aE00947746A66032CCf}
EXPECT_TREASURY=${EXPECT_TREASURY:-0xd631ED63B23204aC30D435048838583E13feAEA0}
EXPECT_ARBITER=${EXPECT_ARBITER:-0xE18798dd9dabD03b0df4BdA61D3b5E7B805bEc85}
EXPECT_FEE_BPS=${EXPECT_FEE_BPS:-250}

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

bold "== Forking ${FORK_URL} on :${RPC_PORT}"
# --auto-impersonate lets us send as the real owner without its key.
# --gas-price 0 / --base-fee 0 stop the upfront gas reservation from starving
# transactions; the L2 data fee still gets charged (anvil mis-models it on a
# fork), which is why the flow tops accounts up before each tx in FORK mode.
anvil --port "$RPC_PORT" --fork-url "$FORK_URL" --auto-impersonate \
  --gas-price 0 --base-fee 0 --silent &
ANVIL_PID=$!
forked=""
for _ in $(seq 1 80); do
  if curl -s -m 2 -X POST "$RPC" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' >/dev/null 2>&1; then
    forked=1; break
  fi
  sleep 0.5
done
if [[ -z "$forked" ]]; then
  echo "anvil never came up — is ${FORK_URL} reachable?" >&2
  exit 1
fi
BLOCK=$(cast block-number --rpc-url "$RPC")
echo "  forked at block ${BLOCK}"

bold "== Inspecting the LIVE escrow ${ESCROW}"
TREASURY=$(
  RPC_URL="$RPC" CHAIN_ID="$CHAIN_ID" ESCROW_ADDRESS="$ESCROW" \
  EXPECT_OWNER="$EXPECT_OWNER" EXPECT_TREASURY="$EXPECT_TREASURY" \
  EXPECT_ARBITER="$EXPECT_ARBITER" EXPECT_FEE_BPS="$EXPECT_FEE_BPS" \
  node scripts/dry-run/fork-prep.mjs
)

bold "== Booting the server against the fork"
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
  npx tsx src/index.ts >/tmp/pokeplay-forkrun-server.log 2>&1
) &
SERVER_PID=$!

up=""
for _ in $(seq 1 60); do
  if curl -s -m 1 "$BASE/api/stats" >/dev/null 2>&1; then up=1; break; fi
  sleep 0.5
done
if [[ -z "$up" ]]; then
  echo "server never came up. log:" >&2
  tail -30 /tmp/pokeplay-forkrun-server.log >&2
  exit 1
fi

# The startup guard reading the REAL contract is the headline check here.
if grep -q "domain + arbiter verified" /tmp/pokeplay-forkrun-server.log; then
  echo "  startup guard: domain + arbiter verified against the live contract"
else
  echo "  ⚠ startup guard did not report a verified domain — check the log" >&2
fi

bold "== Running the scenarios"
RPC_URL="$RPC" CHAIN_ID="$CHAIN_ID" BASE="$BASE" ESCROW_ADDRESS="$ESCROW" \
  IMPERSONATE_OWNER="$EXPECT_OWNER" TREASURY_ADDRESS="$TREASURY" FORK=1 \
  node scripts/dry-run/flow.mjs
code=$?

echo
echo "server log: /tmp/pokeplay-forkrun-server.log"
exit $code
