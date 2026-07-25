#!/usr/bin/env bash
#
# Deploys PokePlay to its host.
#
#   DOMAIN=play.example.com ./scripts/deploy.sh
#
# The host may run other live sites (listed in scripts/deploy.env as NEIGHBOURS),
# so the script verifies each is healthy before it starts AND after it finishes,
# backs the Caddyfile up, and uses `caddy validate` + a graceful reload rather
# than a restart. If anything fails it stops rather than pressing on.
set -euo pipefail

cd "$(dirname "$0")/.."

# Deploy target and neighbour list are kept in a local, gitignored file so the
# public repo never names the production box or unrelated sites on it. Copy
# scripts/deploy.env.example to scripts/deploy.env and fill it in.
[ -f "$(dirname "$0")/deploy.env" ] && . "$(dirname "$0")/deploy.env"

HOST="${HOST:-}"
REMOTE_DIR="/srv/pokeplay"
SERVICE_USER="pokeplay"
API_PORT=8090
DOMAIN="${DOMAIN:-}"

# Other public sites on the same box that must keep working — health-checked
# before and after. Space-separated, from deploy.env (or a NEIGHBOURS env var),
# so the repo does not enumerate unrelated projects.
read -ra NEIGHBOURS <<< "${NEIGHBOURS:-}" || true

if [ -z "$DOMAIN" ]; then
  echo "Set DOMAIN, e.g.  DOMAIN=play.example.com ./scripts/deploy.sh"
  exit 1
fi

if [ -z "$HOST" ]; then
  echo "Set HOST (deploy target) in scripts/deploy.env, e.g.  HOST=user@your.server"
  exit 1
fi

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

probe() {
  curl -s -o /dev/null -m 15 -w '%{http_code}' "$1" 2>/dev/null || echo 000
}

healthy() {
  case "$1" in 200 | 301 | 302) return 0 ;; *) return 1 ;; esac
}

# Snapshot of how each neighbour looked before we touched anything.
# A plain file, not an associative array — macOS ships bash 3.2, which has none.
BEFORE_FILE=$(mktemp)
trap 'rm -f "$BEFORE_FILE"' EXIT

snapshot_neighbours() {
  : > "$BEFORE_FILE"
  for url in ${NEIGHBOURS[@]+"${NEIGHBOURS[@]}"}; do
    local code
    code=$(probe "$url")
    echo "$url $code" >> "$BEFORE_FILE"
    if healthy "$code"; then
      echo "  ok      $url ($code)"
    else
      # Not fatal: a site can already be down for reasons that have nothing to
      # do with this deploy (pokeplay.fun currently has no DNS records). We
      # only care that we do not make anything *worse*.
      echo "  already down  $url ($code) — will not be treated as our fault"
    fi
  done
}

# Fails only if something that was working before is broken now.
verify_neighbours() {
  local regressed=0
  for url in ${NEIGHBOURS[@]+"${NEIGHBOURS[@]}"}; do
    local now after
    now=$(awk -v u="$url" '$1 == u { print $2 }' "$BEFORE_FILE")
    after=$(probe "$url")
    if healthy "$now" && ! healthy "$after"; then
      echo "  REGRESSED  $url ($now -> $after)"
      regressed=1
    else
      echo "  unchanged  $url ($now -> $after)"
    fi
  done
  return $regressed
}

say "Recording how the other sites on this box look right now"
snapshot_neighbours

say "Building the frontend"
# The API is same-origin in production, so the base URL is empty.
VITE_API_BASE="" npm run build

say "Shipping files"
ssh "$HOST" "id $SERVICE_USER >/dev/null 2>&1 || useradd --system --home-dir /var/lib/slabshowdown --shell /usr/sbin/nologin $SERVICE_USER"
ssh "$HOST" "mkdir -p $REMOTE_DIR/server $REMOTE_DIR/data $REMOTE_DIR/dist $REMOTE_DIR/deploy /var/lib/slabshowdown"

# --delete keeps the remote clean, but never touches the database: that lives
# in /var/lib/slabshowdown, outside this tree, on purpose.
rsync -az --delete dist/ "$HOST:$REMOTE_DIR/dist/"
rsync -az --delete \
  --exclude node_modules --exclude .env --exclude 'data/*.db*' \
  server/src server/package.json server/tsconfig.json "$HOST:$REMOTE_DIR/server/"
rsync -az data/pokedex.json "$HOST:$REMOTE_DIR/data/pokedex.json"
rsync -az deploy/watchdog.mjs "$HOST:$REMOTE_DIR/deploy/watchdog.mjs"
rsync -az deploy/backup.mjs "$HOST:$REMOTE_DIR/deploy/backup.mjs"

say "Installing server dependencies"
ssh "$HOST" "cd $REMOTE_DIR/server && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3"

say "Writing the service environment"
# DEV_LOGIN is deliberately absent — it is an auth bypass.
# ESCROW_ADDRESS is empty, which disables paid wagering entirely.
# Settings configured by hand on the box must survive a deploy, or the next
# one silently un-configures the site. Read them back before rewriting.
#
# The arbiter key is read back and written back like the others, but its VALUE
# is never echoed — a private key must not land in the deploy log. We only
# report whether one is present.
# Read the whole existing env back in ONE ssh call. Four separate calls (as
# this used to do) give a flaky connection four chances to return empty for a
# single key and blank it on write — which is exactly how ESCROW_ADDRESS once
# got wiped, silently disabling settlement, while the other keys survived. One
# call gets the file whole or not at all.
KEEP_ENV=$(ssh "$HOST" "cat $REMOTE_DIR/server/.env 2>/dev/null" || true)
keep() { printf '%s\n' "$KEEP_ENV" | grep -E "^$1=" | tail -1 | cut -d= -f2-; }
KEEP_ADMINS=$(keep ADMIN_ADDRESSES)
KEEP_ESCROW=$(keep ESCROW_ADDRESS)
KEEP_POOL=$(keep TOURNAMENT_POOL_ADDRESS)
KEEP_ARBITER=$(keep ARBITER_PRIVATE_KEY)
ADMIN_ADDRESSES="${ADMIN_ADDRESSES:-$KEEP_ADMINS}"
ESCROW_ADDRESS="${ESCROW_ADDRESS:-$KEEP_ESCROW}"
# Set TOURNAMENT_POOL_ADDRESS=0x… on the deploy command the first time to enable
# paid tournaments; thereafter it is read back and preserved like the others.
TOURNAMENT_POOL_ADDRESS="${TOURNAMENT_POOL_ADDRESS:-$KEEP_POOL}"
ARBITER_PRIVATE_KEY="${ARBITER_PRIVATE_KEY:-$KEEP_ARBITER}"

# A money site must never silently ship with settlement off. If escrow or the
# arbiter came out empty — nearly always a dropped read over a flaky link, since
# the box already had them — stop, rather than write an .env that turns paid
# wagering off. Pass ALLOW_NO_SETTLEMENT=1 for a box that is intentionally
# free-only, or pass the values explicitly to set them.
if [[ -z "${ALLOW_NO_SETTLEMENT:-}" && ( -z "$ESCROW_ADDRESS" || -z "$ARBITER_PRIVATE_KEY" ) ]]; then
  echo "ERROR: ESCROW_ADDRESS or ARBITER_PRIVATE_KEY resolved empty." >&2
  echo "Refusing to deploy an .env that disables settlement — this is almost" >&2
  echo "certainly a dropped read over a flaky SSH connection, not a real change." >&2
  echo "Re-run the deploy, pass the value explicitly (ESCROW_ADDRESS=0x… ./scripts/deploy.sh)," >&2
  echo "or set ALLOW_NO_SETTLEMENT=1 if this box is meant to be free-only." >&2
  exit 1
fi
[[ -n "$ADMIN_ADDRESSES" ]] && echo "  admins:  $ADMIN_ADDRESSES"
[[ -n "$ESCROW_ADDRESS" ]] && echo "  escrow:  $ESCROW_ADDRESS"
[[ -n "$TOURNAMENT_POOL_ADDRESS" ]] && echo "  pool:    $TOURNAMENT_POOL_ADDRESS"
[[ -n "$ARBITER_PRIVATE_KEY" ]] && echo "  arbiter: set (value hidden)"

# Written with restrictive perms from the start, and never through the shell
# history or the deploy log. The heredoc is quoted so nothing here expands
# locally; the values are substituted on the remote side only.
ssh "$HOST" "umask 077 && cat > $REMOTE_DIR/server/.env <<EOF
NODE_ENV=production
PORT=$API_PORT
HOST=127.0.0.1
DB_PATH=/var/lib/slabshowdown/app.db
CORS_ORIGIN=https://$DOMAIN
CHAIN_ID=4663
ESCROW_ADDRESS=$ESCROW_ADDRESS
TOURNAMENT_POOL_ADDRESS=$TOURNAMENT_POOL_ADDRESS
ADMIN_ADDRESSES=$ADMIN_ADDRESSES
ARBITER_PRIVATE_KEY=$ARBITER_PRIVATE_KEY
EOF
chmod 600 $REMOTE_DIR/server/.env"

say "Locking down ownership for the service user"
ssh "$HOST" "chown -R $SERVICE_USER:$SERVICE_USER $REMOTE_DIR /var/lib/slabshowdown && \
  chmod 755 $REMOTE_DIR $REMOTE_DIR/dist && \
  chmod 750 $REMOTE_DIR/server && \
  chmod 600 $REMOTE_DIR/server/.env"

# A restart drops every in-memory battle. The server closes the orphans as
# draws on the way back up, but that is damage control — better to wait for
# them to finish. FORCE=1 skips the wait.
say "Checking for live battles"
DRAIN_SECONDS=${DRAIN_SECONDS:-120}
waited=0
while :; do
  live=$(ssh "$HOST" "curl -sf -m 5 http://127.0.0.1:$API_PORT/api/stats" \
    | sed -n 's/.*"liveBattles":\([0-9]*\).*/\1/p')
  live=${live:-0}
  if [[ "$live" == "0" ]]; then
    echo "  no live battles — safe to restart"
    break
  fi
  if [[ "${FORCE:-}" == "1" ]]; then
    echo "  ⚠ $live battle(s) live, FORCE=1 — restarting anyway; they will end as draws"
    break
  fi
  if (( waited >= DRAIN_SECONDS )); then
    echo "  ✖ $live battle(s) still live after ${DRAIN_SECONDS}s." >&2
    echo "    Re-run with FORCE=1 to restart anyway (those matches end as draws)," >&2
    echo "    or with DRAIN_SECONDS=<n> to wait longer." >&2
    exit 1
  fi
  echo "  $live battle(s) in progress — waiting (${waited}s/${DRAIN_SECONDS}s)"
  sleep 10
  waited=$((waited + 10))
done

say "Installing the systemd unit"
scp -q deploy/slabshowdown.service "$HOST:/etc/systemd/system/slabshowdown.service"
# `enable --now` only STARTS a stopped unit — it will happily leave an old
# process running with the previous code while the deploy reports success.
# Restart explicitly, then show the pid so a stale process is obvious.
ssh "$HOST" "systemctl daemon-reload && systemctl enable slabshowdown >/dev/null 2>&1; systemctl restart slabshowdown && sleep 5 && systemctl is-active slabshowdown"
echo "  pid:     $(ssh "$HOST" "systemctl show -p MainPID --value slabshowdown")"
echo "  started: $(ssh "$HOST" "systemctl show -p ActiveEnterTimestamp --value slabshowdown")"

say "Installing the watchdog timer"
scp -q deploy/slabshowdown-backup.service "$HOST:/etc/systemd/system/slabshowdown-backup.service"
scp -q deploy/slabshowdown-backup.timer "$HOST:/etc/systemd/system/slabshowdown-backup.timer"
ssh "$HOST" "mkdir -p /var/backups/slabshowdown && chown $SERVICE_USER:$SERVICE_USER /var/backups/slabshowdown && systemctl enable --now slabshowdown-backup.timer >/dev/null 2>&1"
scp -q deploy/slabshowdown-watchdog.service "$HOST:/etc/systemd/system/slabshowdown-watchdog.service"
scp -q deploy/slabshowdown-watchdog.timer "$HOST:/etc/systemd/system/slabshowdown-watchdog.timer"
# Create the env file only if it is missing, so a webhook added by hand on the
# box is never overwritten by a deploy.
ssh "$HOST" "test -f /etc/slabshowdown-watchdog.env || {
  printf '# ALERT_WEBHOOK=https://discord.com/api/webhooks/...\n# HEALTH_TOKEN=\n' \
    > /etc/slabshowdown-watchdog.env
  chmod 600 /etc/slabshowdown-watchdog.env
}"
ssh "$HOST" "systemctl daemon-reload && systemctl enable --now slabshowdown-watchdog.timer >/dev/null 2>&1 && systemctl is-active slabshowdown-watchdog.timer"
echo "  next run: $(ssh "$HOST" "systemctl show -p NextElapseUSecRealtime --value slabshowdown-watchdog.timer")"

say "Verifying the API answers locally on the box"
ssh "$HOST" "curl -sf -m 10 http://127.0.0.1:$API_PORT/api/stats" || {
  echo "API did not answer. Recent logs:"
  ssh "$HOST" "journalctl -u slabshowdown -n 30 --no-pager"
  exit 1
}
echo

say "Confirming the running server is the code we just shipped"
# A stale process is the failure this deploy already shipped once: files
# updated, service never restarted, everything reported green. Probe an
# endpoint that only exists in the new build.
if ssh "$HOST" "curl -sf -m 10 http://127.0.0.1:$API_PORT/api/practice/opponents" >/dev/null 2>&1; then
  echo "  ok   /api/practice/opponents responds (new code is live)"
else
  echo "  FAIL the running server does not serve /api/practice/opponents."
  echo "       It is probably a stale process. Recent logs:"
  ssh "$HOST" "journalctl -u slabshowdown -n 20 --no-pager"
  exit 1
fi

say "Confirming dev login is OFF in production"
if ssh "$HOST" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$API_PORT/api/auth/dev-accounts" | grep -q 404; then
  echo "  ok   /api/auth/dev-accounts returns 404"
else
  echo "  FAIL dev login is reachable in production. Stopping."
  exit 1
fi

say "Updating Caddy"
STAMP=$(date +%Y%m%d-%H%M%S)
ssh "$HOST" "cp /etc/caddy/Caddyfile /root/Caddyfile.bak-before-slabshowdown-$STAMP"
echo "  backup: /root/Caddyfile.bak-before-slabshowdown-$STAMP"

# pokeplay.fun already has a block serving the old PokePlay site. Hand the
# apex over by commenting that block out (never deleting it) and appending
# ours. play.pokeplay.fun is left untouched, so re-adding that DNS record
# brings the old game back.
sed "s/__DOMAIN__/$DOMAIN/g" deploy/caddy-block.template > /tmp/slab-block.caddy
scp -q /tmp/slab-block.caddy "$HOST:/tmp/slab-block.caddy"
scp -q deploy/swap-apex.py "$HOST:/tmp/swap-apex.py"
ssh "$HOST" "python3 /tmp/swap-apex.py /etc/caddy/Caddyfile /tmp/slab-block.caddy"

say "Validating the Caddyfile"
ssh "$HOST" "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile" || {
  echo "Caddyfile invalid — restoring the backup and stopping."
  ssh "$HOST" "cp /root/Caddyfile.bak-before-slabshowdown-$STAMP /etc/caddy/Caddyfile"
  exit 1
}

say "Reloading Caddy (graceful, never restart)"
ssh "$HOST" "systemctl reload caddy"
sleep 5

say "Checking nothing on this box regressed"
if ! verify_neighbours; then
  echo "A neighbour broke. Restoring the Caddyfile and reloading."
  ssh "$HOST" "cp /root/Caddyfile.bak-before-slabshowdown-$STAMP /etc/caddy/Caddyfile && systemctl reload caddy"
  exit 1
fi

say "Checking the new site"
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$DOMAIN" || echo 000)
  [ "$code" = "200" ] && break
  echo "  waiting for TLS… ($code)"
  sleep 6
done
echo "  https://$DOMAIN -> $code"
curl -sf -m 10 "https://$DOMAIN/api/stats" && echo

say "Done"
echo "Site:  https://$DOMAIN"
echo "Logs:  ssh $HOST 'journalctl -u slabshowdown -f'"
echo "DB:    /var/lib/slabshowdown/app.db  (outside the deploy tree)"
