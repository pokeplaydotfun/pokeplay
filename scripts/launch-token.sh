#!/usr/bin/env bash
#
# Point pokeplay.fun at $PLAY once it has been launched on Pons.
#
#   ./scripts/launch-token.sh --dry-run <tokenAddress> [feeWallet]   verify only, change nothing
#   ./scripts/launch-token.sh          <tokenAddress> [feeWallet]    go live
#   ./scripts/launch-token.sh --clear  [feeWallet]                   back to pre-launch
#
# WHAT THIS DOES NOT DO: it does not create the token and it does not choose the fee
# recipient. Pons snapshots the creator's fee wallet at launch, from the address set in their
# interface, and it never changes afterward. This script only tells our own stack which token
# and which wallet to read. Launch with a different wallet than the one passed here and the
# token page reads zero fees forever, so the second argument must match the actual launch.
#
# The fee wallet defaults to 0xd631ED63…AEA0, the hot worker that is already the treasury of
# both wager contracts and the revenue recipient of the cards stack. Verified 29 Jul 2026:
# that wallet has received ZERO WETH from the Pons locker, so "Fees generated" opens at zero,
# which is the only honest figure for a token that has not traded yet. That check matters —
# the locker is GLOBAL to every Pons launch and our reader counts every WETH transfer out of
# it, so a wallet that already collects fees for some other token would open $PLAY's page at
# that other token's lifetime earnings. Measured, not assumed: a fee wallet from an earlier
# launch reads 0.1076 WETH today, which would be exactly the wrong opening number here. Step 3
# re-runs that check against whatever wallet is passed, so it cannot be skipped by accident.
#
# Everything is verified against the chain BEFORE anything changes, so a wrong address fails
# here rather than showing wrong numbers to visitors.
set -euo pipefail

DRY=false
if [[ "${1:-}" == "--dry-run" ]]; then DRY=true; shift; fi

# --clear un-launches: drops the CA everywhere so the site goes back to saying "TBA". For the
# gap between a dead token and its replacement, so visitors never see an abandoned contract.
CLEAR=false
if [[ "${1:-}" == "--clear" ]]; then CLEAR=true; shift; fi

DEFAULT_FEE_WALLET=0xd631ED63B23204aC30D435048838583E13feAEA0

if [[ "$CLEAR" == "true" ]]; then
  TOKEN=""
  FEE_WALLET="${1:-$DEFAULT_FEE_WALLET}"
else
  TOKEN="${1:?usage: ./scripts/launch-token.sh [--dry-run] <tokenAddress> [feeWallet]  |  --clear [feeWallet]}"
  FEE_WALLET="${2:-$DEFAULT_FEE_WALLET}"
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$REPO/src/config.ts"
DOMAIN="${DOMAIN:-pokeplay.fun}"

# The box is named in scripts/deploy.env, which is gitignored — this repo is public and
# naming the host that holds the operator's hot wallet only tells people where to aim.
# shellcheck disable=SC1090
source "$REPO/scripts/deploy.env"
HOST="${HOST:?scripts/deploy.env must set HOST}"

RPC="https://rpc.mainnet.chain.robinhood.com"
V3_FACTORY="0x1f7d7550B1b028f7571E69A784071F0205FD2EfA"
WETH="0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"
LOCKER="0x736D76699C26D0d966744cAe304C000d471f7F35"
# Pons factory deployment. Anything earlier cannot contain a Pons fee payment.
FACTORY_START=8991118

command -v cast >/dev/null || { echo "cast not found — add foundry to PATH"; exit 1; }
[[ "$FEE_WALLET" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "FATAL: '$FEE_WALLET' is not an address"; exit 1; }

# Rewrites the single TOKEN_ADDRESS_DEFAULT line in src/config.ts. That default, rather than a
# build-time variable, is what makes the CA survive every later routine deploy.
set_config_default() {
  local value="$1"
  local before
  before=$(grep -c "^const TOKEN_ADDRESS_DEFAULT = " "$CONFIG" || true)
  [[ "$before" == "1" ]] || {
    echo "FATAL: expected exactly one TOKEN_ADDRESS_DEFAULT line in src/config.ts, found $before" >&2
    exit 1
  }
  # macOS bsd sed needs the empty -i argument; the pattern is anchored so nothing else moves.
  sed -i '' "s|^const TOKEN_ADDRESS_DEFAULT = .*|const TOKEN_ADDRESS_DEFAULT = '$value'|" "$CONFIG" \
    2>/dev/null || sed -i "s|^const TOKEN_ADDRESS_DEFAULT = .*|const TOKEN_ADDRESS_DEFAULT = '$value'|" "$CONFIG"
  grep -q "^const TOKEN_ADDRESS_DEFAULT = '$value'$" "$CONFIG" || {
    echo "FATAL: failed to write the CA into src/config.ts" >&2; exit 1;
  }
}

# ---------------------------------------------------------------- clear (un-launch)

if [[ "$CLEAR" == "true" ]]; then
  OLD_CA=$(sed -n "s|^const TOKEN_ADDRESS_DEFAULT = '\(0x[0-9a-fA-F]*\)'.*|\1|p" "$CONFIG" | head -1)
  echo "==> CLEAR: dropping the CA (was: ${OLD_CA:-none}) and arming the fee wallet $FEE_WALLET"

  echo "==> 1/4 updating the cards backend env and restarting"
  ssh "$HOST" "cd /srv/slabs/backend && \
    cp .env .env.bak-token-\$(date +%Y%m%d-%H%M%S) && \
    sed -i '/^PONS_TOKEN_ADDRESS=/d;/^PONS_FEE_WALLET=/d' .env && \
    printf 'PONS_FEE_WALLET=%s\n' '$FEE_WALLET' >> .env && \
    systemctl restart slabs-api && sleep 4 && systemctl is-active slabs-api"

  echo "==> 2/4 confirming the API reports pre-launch"
  for i in $(seq 1 20); do
    BODY=$(curl -s --max-time 15 "https://$DOMAIN/slabs-api/token/stats" || true)
    # An absent CA must read as live:false, not as a stale CA with dead numbers.
    if echo "$BODY" | grep -q '"live":false'; then echo "    $BODY"; break; fi
    [[ "$i" == "20" ]] && { echo "FATAL: still reporting live after 20 tries. Last: $BODY"; exit 1; }
    sleep 3
  done

  echo "==> 3/4 stripping the CA from the source default"
  set_config_default ""

  echo "==> 4/4 deploying"
  export RSYNC_RSH="ssh -o ServerAliveInterval=10 -o ServerAliveCountMax=6 -o TCPKeepAlive=yes"
  ( cd "$REPO" && DOMAIN="$DOMAIN" ./scripts/deploy.sh >/dev/null )

  # The bundle outlives a restart, so prove the old CA is really gone rather than trusting sed.
  if [[ -n "$OLD_CA" ]] && grep -rqiF "$OLD_CA" "$REPO"/dist/assets/*.js; then
    echo "FATAL: $OLD_CA is STILL in the built bundle — the site may show a dead CA." >&2
    exit 1
  fi
  [[ -n "$OLD_CA" ]] && echo "    verified: $OLD_CA is gone from the bundle"
  echo
  echo "==> DONE. The homepage and token page are back to TBA. Fee wallet armed as $FEE_WALLET."
  curl -s "https://$DOMAIN/slabs-api/token/stats" | sed 's/^/    /'
  exit 0
fi

# ---------------------------------------------------------------- launch

[[ "$TOKEN" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "FATAL: '$TOKEN' is not an address"; exit 1; }

echo "==> 1/6 verifying the token exists on chain"
CODE=$(cast code "$TOKEN" --rpc-url "$RPC" 2>/dev/null | wc -c | tr -d ' ')
[[ "$CODE" -gt 4 ]] || { echo "FATAL: no contract at $TOKEN. Has the launch landed?"; exit 1; }
SYMBOL=$(cast call "$TOKEN" "symbol()(string)" --rpc-url "$RPC" 2>/dev/null | tr -d '"')
DECIMALS=$(cast call "$TOKEN" "decimals()(uint8)" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}')
SUPPLY=$(cast call "$TOKEN" "totalSupply()(uint256)" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}')
echo "    symbol=$SYMBOL decimals=$DECIMALS totalSupply=$SUPPLY"
# A wrong-token paste is the failure this catches: it would publish somebody else's contract
# on our homepage. The symbol is the only human-readable check the chain offers, so it is a
# confirmation prompt rather than a hard stop (a launch could legitimately use another symbol).
if [[ "$SYMBOL" != "PLAY" ]]; then
  echo "    ⚠ symbol is '$SYMBOL', not PLAY. Is this the right contract?"
  read -r -p "    type the symbol again to continue: " CONFIRM
  [[ "$CONFIRM" == "$SYMBOL" ]] || { echo "aborted"; exit 1; }
fi

echo "==> 2/6 finding the Pons pool (WETH pair, standard V3 fee tiers)"
POOL=""
for FEE in 10000 3000 500; do
  P=$(cast call "$V3_FACTORY" "getPool(address,address,uint24)(address)" "$TOKEN" "$WETH" "$FEE" --rpc-url "$RPC" 2>/dev/null || true)
  if [[ -n "$P" && "$P" != "0x0000000000000000000000000000000000000000" ]]; then POOL="$P"; TIER="$FEE"; break; fi
done
[[ -n "$POOL" ]] || { echo "FATAL: no WETH pool for $TOKEN. Pons may still be creating it — wait and retry."; exit 1; }
echo "    pool=$POOL (fee tier $TIER)"

echo "==> 3/6 checking what 'Fees generated' would open at"
# Run through the same rule the dashboard uses (see scripts/pons-opening-fees.mjs), so this is
# the figure the page would actually show rather than a proxy for it.
#
# ⚠ This must FAIL CLOSED. The first version of this check shelled out to `cast logs` with the
# error swallowed; cast dropped the second topic on this RPC, answered "exceeds limit of 10000",
# and the guard read that as a clean wallet — reporting zero for a wallet holding 32 payments.
# A guard that cannot measure must stop the launch, not wave it through.
OPENING=$(node "$REPO/scripts/pons-opening-fees.mjs" "$TOKEN" "$FEE_WALLET") || {
  echo "FATAL: could not measure the opening fee figure for $FEE_WALLET. Not launching blind." >&2
  exit 1
}
PRIOR_WEI=$(echo "$OPENING" | sed -n 's/^WEI=//p')
PRIOR_N=$(echo "$OPENING" | sed -n 's/^PAYMENTS=//p')
PRIOR_ETH=$(echo "$OPENING" | sed -n 's/^ETH=//p')
[[ -n "$PRIOR_WEI" ]] || { echo "FATAL: fee check returned no figure. Not launching blind." >&2; exit 1; }
if [[ "$PRIOR_WEI" != "0" ]]; then
  echo "    ⚠⚠ $FEE_WALLET has ALREADY received $PRIOR_N Pons fee payment(s) totalling"
  echo "       $PRIOR_ETH WETH. The token page would OPEN at that figure, which belongs to"
  echo "       another token — the Pons locker is shared by every launch."
  read -r -p "    type CARRYOVER to publish that as this token's fees: " CONFIRM
  [[ "$CONFIRM" == "CARRYOVER" ]] || { echo "aborted"; exit 1; }
else
  echo "    clean: $FEE_WALLET opens at 0 WETH (no prior Pons fee payments)"
fi

if [[ "$DRY" == "true" ]]; then
  echo
  echo "==> DRY RUN — verification passed, nothing was changed."
  echo "    token      $TOKEN  ($SYMBOL)"
  echo "    pool       $POOL  (fee tier $TIER)"
  echo "    feeWallet  $FEE_WALLET"
  echo "    Re-run without --dry-run to go live."
  exit 0
fi

echo "==> 4/6 updating the cards backend env and restarting"
# The CA and the fee wallet are two halves of one switch: the token gives price and market cap,
# the wallet gives fees. Written together so the dashboard never goes live half-configured.
ssh "$HOST" "cd /srv/slabs/backend && \
  cp .env .env.bak-token-\$(date +%Y%m%d-%H%M%S) && \
  sed -i '/^PONS_TOKEN_ADDRESS=/d;/^PONS_FEE_WALLET=/d' .env && \
  printf 'PONS_TOKEN_ADDRESS=%s\nPONS_FEE_WALLET=%s\n' '$TOKEN' '$FEE_WALLET' >> .env && \
  systemctl restart slabs-api && sleep 4 && systemctl is-active slabs-api"

echo "==> 5/6 waiting for the dashboard to report live numbers"
for i in $(seq 1 20); do
  BODY=$(curl -s --max-time 20 "https://$DOMAIN/slabs-api/token/stats" || true)
  if echo "$BODY" | grep -q '"live":true'; then echo "    $BODY"; break; fi
  [[ "$i" == "20" ]] && { echo "FATAL: still not live after 20 tries. Last: $BODY"; exit 1; }
  sleep 3
done

echo "==> 6/6 baking the CA into the site and deploying"
set_config_default "$TOKEN"
# This box drops sustained rsync transfers without keepalives — a known deploy failure, and a
# bad one to hit here, since the backend is already reporting a launched token by this point.
export RSYNC_RSH="ssh -o ServerAliveInterval=10 -o ServerAliveCountMax=6 -o TCPKeepAlive=yes"
( cd "$REPO" && DOMAIN="$DOMAIN" ./scripts/deploy.sh >/dev/null )

# Prove the address actually reached the SERVED bundle. The homepage pill and the token page
# both read it from the bundle, not from the API, so this is what visitors see.
#
# ⚠ Find the chunk rather than assuming index-*.js: config.ts is code-split, so the CA lands in
# a shared chunk (api-*.js today) and a check aimed at the entry bundle would report a working
# launch as broken. Ask the local dist which file holds it, then fetch that same file from the
# live host — deploy ships dist verbatim, so the hashed name matches.
CHUNK=$(grep -rlF "$TOKEN" "$REPO"/dist/assets/*.js 2>/dev/null | head -1)
[[ -n "$CHUNK" ]] || { echo "FATAL: $TOKEN is not in the freshly built dist at all." >&2; exit 1; }
CHUNK_URL="/assets/$(basename "$CHUNK")"
if curl -s --max-time 30 "https://$DOMAIN$CHUNK_URL" | grep -qiF "$TOKEN"; then
  echo "    verified: $TOKEN is in the served bundle ($CHUNK_URL)"
else
  echo "FATAL: $TOKEN is NOT in the served bundle $CHUNK_URL — the site still shows TBA." >&2
  exit 1
fi

echo
echo "==> DONE. $SYMBOL is live on the homepage, the token page and the dashboard."
curl -s "https://$DOMAIN/slabs-api/token/stats" | sed 's/^/    /'
echo
echo "    Commit the CA so it is not lost: git add src/config.ts && git commit"
