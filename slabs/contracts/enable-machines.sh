#!/usr/bin/env bash
#
# Enable the four sale machines on a freshly deployed PackSale.
#
# This is the ONE on-chain step left after Deploy.s.sol runs: the deploy hands ownership to
# OWNER_ADDRESS and leaves every machine DISABLED on purpose, so a fresh collection cannot take
# money until someone deliberately turns the machines on. That someone is the owner key.
#
# Prices mirror what is live on the current production PackSale (read on 2026-07-26):
#   pokemon_50   $50    water_100  $100    pokemon_250  $250    pokemon_1000  $1000
# All USDG, 6 decimals. Adjust below only if Collector Crypt's live prices have moved.
#
#   ./enable-machines.sh <packSaleAddress>          # dry run — prints the calls, sends nothing
#   ./enable-machines.sh <packSaleAddress> --live   # actually broadcast (owner-signed)
#
# Requires in contracts/.env:  RH_RPC_URL  and  OWNER_PRIVATE_KEY  (the cold admin key that
# Deploy.s.sol handed ownership to — NOT the deployer key). The key never leaves this machine.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
export PATH="$HOME/.foundry/bin:$PATH"

SALE="${1:?usage: ./enable-machines.sh <packSaleAddress> [--live]}"
LIVE="${2:-}"
[[ "$SALE" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "!! '$SALE' is not an address"; exit 1; }

[[ -f .env ]] || { echo "!! contracts/.env not found"; exit 1; }
set -a; source .env; set +a
: "${RH_RPC_URL:?set RH_RPC_URL in .env}"
: "${OWNER_PRIVATE_KEY:?set OWNER_PRIVATE_KEY in .env (the cold admin key, post-transfer owner)}"
[[ "$OWNER_PRIVATE_KEY" == 0x* ]] || OWNER_PRIVATE_KEY="0x${OWNER_PRIVATE_KEY}"

# Machine id -> price in USDG base units (6dp). Order is display order.
# A case lookup, not an associative array — macOS ships bash 3.2, which has no `declare -A`.
MACHINES=(pokemon_50 water_100 pokemon_250 pokemon_1000)
price_for() {
  case "$1" in
    pokemon_50)   echo 50000000 ;;
    water_100)    echo 100000000 ;;
    pokemon_250)  echo 250000000 ;;
    pokemon_1000) echo 1000000000 ;;
    *) echo "!! unknown machine $1" >&2; exit 1 ;;
  esac
}

SIGNER=$(cast wallet address --private-key "$OWNER_PRIVATE_KEY")
OWNER=$(cast call "$SALE" "owner()(address)" --rpc-url "$RH_RPC_URL")
echo "PackSale : $SALE"
echo "owner    : $OWNER"
echo "signer   : $SIGNER"
echo
if [[ "$(printf %s "$OWNER" | tr A-Z a-z)" != "$(printf %s "$SIGNER" | tr A-Z a-z)" ]]; then
  echo "!! OWNER_PRIVATE_KEY ($SIGNER) is not PackSale.owner ($OWNER). setMachine is onlyOwner."
  echo "   Confirm ownership was transferred to this key, or supply the right one."
  exit 1
fi

if [[ "$LIVE" != "--live" ]]; then
  echo "==> dry run (nothing broadcast). Re-run with --live to send."
else
  echo "==> BROADCASTING setMachine x${#MACHINES[@]} from the owner key"
fi
echo

for m in "${MACHINES[@]}"; do
  ID=$(cast format-bytes32-string "$m")
  P=$(price_for "$m")
  printf '  setMachine(%s, %s, true)   # %-13s $%s\n' "$m" "$P" "$m" "$((P/1000000))"
  if [[ "$LIVE" == "--live" ]]; then
    cast send "$SALE" "setMachine(bytes32,uint96,bool)" "$ID" "$P" true \
      --private-key "$OWNER_PRIVATE_KEY" --rpc-url "$RH_RPC_URL" >/dev/null
  fi
done

echo
echo "==> current on-chain state:"
for m in "${MACHINES[@]}"; do
  ID=$(cast format-bytes32-string "$m")
  RES=$(cast call "$SALE" "machines(bytes32)(uint96,bool)" "$ID" --rpc-url "$RH_RPC_URL" | tr '\n' ' ')
  printf '  %-13s -> %s\n' "$m" "$RES"
done
[[ "$LIVE" == "--live" ]] || echo -e "\n(dry run — state above is still the pre-run values)"
