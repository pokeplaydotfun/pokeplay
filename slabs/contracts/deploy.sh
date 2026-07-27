#!/usr/bin/env bash
#
# Deploy the PWA contracts to Robinhood Chain.
#
# Reads contracts/.env, which is NEVER committed. Runs a dry run and a set of preflight
# checks first, because every one of these deploys is irreversible: ownership is handed over
# in the same transaction batch, and a wrong role address cannot be taken back.
#
#   ./deploy.sh          simulate only, broadcast nothing
#   ./deploy.sh --live   actually broadcast
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
export PATH="$HOME/.foundry/bin:$PATH"

[[ -f .env ]] || { echo "!! contracts/.env not found. Copy .env.example and fill it in."; exit 1; }
set -a; source .env; set +a

for v in RH_RPC_URL DEPLOYER_PRIVATE_KEY USDG_ADDRESS OWNER_ADDRESS WORKER_ADDRESS \
         GUARDIAN_ADDRESS TREASURY_ADDRESS MAX_PACK_PRICE_USDG MARKET_FEE_BPS; do
  [[ -n "${!v:-}" ]] || { echo "!! $v is empty in .env"; exit 1; }
done

# Single-key setup, chosen by the operator (2026-07-22) with the trade-off understood.
# Noted rather than warned about: the decision is made, and a scare banner on every deploy
# would just train the operator to scroll past the output that actually matters.
#
# It stays reversible without a redeploy — sale.transferOwnership() and
# mirror.transferOwnership() can split the roles later.
if [[ "$OWNER_ADDRESS" == "$WORKER_ADDRESS" || "$TREASURY_ADDRESS" == "$WORKER_ADDRESS" ]]; then
  echo "note: single-key setup — admin, treasury and worker are one wallet (intended)."
  echo
fi

# forge's vm.envUint requires the 0x prefix, while cast accepts the key either way. Normalise
# here so a key pasted without it just works instead of failing deep inside the script.
[[ "$DEPLOYER_PRIVATE_KEY" == 0x* ]] || DEPLOYER_PRIVATE_KEY="0x${DEPLOYER_PRIVATE_KEY}"
export DEPLOYER_PRIVATE_KEY

DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
CHAIN=$(cast chain-id --rpc-url "$RH_RPC_URL")
BAL=$(cast balance "$DEPLOYER" --rpc-url "$RH_RPC_URL")

echo "chain     : $CHAIN"
echo "deployer  : $DEPLOYER"
echo "balance   : $(cast from-wei "$BAL") ETH"
echo "owner     : $OWNER_ADDRESS"
echo "worker    : $WORKER_ADDRESS"
echo "guardian  : $GUARDIAN_ADDRESS"
echo "treasury  : $TREASURY_ADDRESS"
echo

[[ "$CHAIN" == "4663" ]] || { echo "!! expected chain 4663, got $CHAIN"; exit 1; }
[[ "$BAL" != "0" ]]      || { echo "!! deployer has no ETH"; exit 1; }

# Confirm USDG really is USDG at that address before wiring it into three contracts.
SYM=$(cast call "$USDG_ADDRESS" "symbol()(string)" --rpc-url "$RH_RPC_URL")
DEC=$(cast call "$USDG_ADDRESS" "decimals()(uint8)" --rpc-url "$RH_RPC_URL")
echo "USDG      : $SYM, $DEC decimals"
[[ "$SYM" == *USDG* ]] || { echo "!! token at USDG_ADDRESS does not report USDG"; exit 1; }
[[ "$DEC" == "6" ]]    || { echo "!! expected 6 decimals, got $DEC"; exit 1; }
echo

# chain 4663 has exactly ONE public RPC and it sits behind Cloudflare, which starts serving
# browser challenges to automated clients under repeated use. There is no alternative:
# Blockscout's eth-rpc exists but rejects the block parameter on eth_getBalance, so forge
# cannot use it. When challenged, the only fix is to wait for the rate limit to clear.
run_forge() {
  forge script script/Deploy.s.sol --rpc-url "$RH_RPC_URL" "$@" 2>&1
}

MODE_ARGS=()
if [[ "${1:-}" == "--live" ]]; then
  echo "==> BROADCASTING"
  MODE_ARGS=(--broadcast)
else
  echo "==> dry run (nothing broadcast). Re-run with --live to deploy."
fi

OUT="$(run_forge ${MODE_ARGS[@]+"${MODE_ARGS[@]}"})" || true

if grep -q "Just a moment\|HTTP error 403" <<<"$OUT"; then
  echo "!! The RPC served a Cloudflare challenge instead of answering."
  echo "   This is rate limiting, not a problem with the deploy. Nothing was broadcast."
  echo "   Wait a few minutes and run this again."
  exit 1
fi

sed -e 's/<!DOCTYPE html>.*//' <<<"$OUT"

grep -q "ONCHAIN EXECUTION COMPLETE\|SIMULATION COMPLETE" <<<"$OUT" || {
  echo
  echo "!! deploy did not complete. Nothing above says COMPLETE."
  exit 1
}
