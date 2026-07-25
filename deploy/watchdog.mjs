#!/usr/bin/env node
/**
 * External watchdog.
 *
 * Runs off the box's timer, not inside the server, because the failure that
 * matters most — the process being dead — is exactly the one an in-process
 * check can never report.
 *
 * Alerts go to a webhook if ALERT_WEBHOOK is set (Discord and Slack both
 * accept a plain {content|text} JSON body), and always to stdout so journald
 * keeps a record either way.
 *
 * State lives in a small file so a continuing problem does not re-alert every
 * run, and a recovery is announced once.
 *
 *   URL             base url to check   (default https://pokeplay.fun)
 *   HEALTH_TOKEN    to get detailed output
 *   ALERT_WEBHOOK   Discord/Slack incoming webhook
 *   STATE_FILE      default /var/lib/slabshowdown/watchdog.json
 *   REPEAT_AFTER    re-alert on a still-failing check after N seconds (default 3600)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const URL_BASE = process.env.URL ?? 'https://pokeplay.fun'
const TOKEN = process.env.HEALTH_TOKEN ?? ''
const WEBHOOK = process.env.ALERT_WEBHOOK ?? ''
const STATE_FILE = process.env.STATE_FILE ?? '/var/lib/slabshowdown/watchdog.json'
const REPEAT_AFTER = Number(process.env.REPEAT_AFTER ?? 3600)
const TIMEOUT_MS = 15_000

const nowSec = () => Math.floor(Date.now() / 1000)

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { failing: {}, down: false }
  }
}

function saveState(state) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state))
  } catch (e) {
    console.error(`watchdog: could not persist state to ${STATE_FILE}: ${e.message}`)
  }
}

async function alert(text) {
  console.error(text)
  if (!WEBHOOK) return
  try {
    await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Discord reads `content`, Slack reads `text`. Sending both suits either.
      body: JSON.stringify({ content: text, text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    console.error(`watchdog: webhook failed: ${e.message}`)
  }
}

async function probe() {
  const url = `${URL_BASE}/api/health${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''}`
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

const state = loadState()
let result = null
let reachErr = null

try {
  result = await probe()
} catch (e) {
  reachErr = e.message
}

/* ---- unreachable ------------------------------------------------- */

if (reachErr !== null) {
  if (!state.down) {
    await alert(`🔴 PokePlay is UNREACHABLE at ${URL_BASE} — ${reachErr}`)
    state.down = true
    state.downSince = nowSec()
  } else if (nowSec() - (state.downSince ?? 0) > REPEAT_AFTER) {
    await alert(`🔴 PokePlay still unreachable (${Math.floor((nowSec() - state.downSince) / 60)}m)`)
    state.downSince = nowSec()
  }
  saveState(state)
  process.exit(1)
}

if (state.down) {
  await alert(`🟢 PokePlay is reachable again (${URL_BASE})`)
  state.down = false
  delete state.downSince
}

/* ---- health checks ----------------------------------------------- */

const { status, body } = result

/**
 * A response that is not a health payload is itself a failure.
 *
 * Without this, pointing the watchdog at the wrong URL — or at a build that
 * predates /api/health — returns 404 with no `checks`, produces an empty
 * failing list, and reports "ok" forever. Silently passing is the one thing a
 * watchdog must never do.
 */
let failing
if (typeof body?.ok !== 'boolean') {
  failing = [{
    name: 'endpoint',
    detail: `${URL_BASE}/api/health returned HTTP ${status} without a health payload`,
  }]
} else if (body.checks) {
  failing = body.checks.filter((c) => !c.ok)
} else {
  failing = (body.failing ?? []).map((name) => ({ name, detail: undefined }))
  // Terse mode: ok=false must fail even if the names are withheld.
  if (!body.ok && failing.length === 0) failing = [{ name: 'unspecified', detail: undefined }]
}

const seen = new Set()

for (const check of failing) {
  seen.add(check.name)
  const prev = state.failing[check.name]
  if (!prev || nowSec() - prev > REPEAT_AFTER) {
    const detail = check.detail ? ` — ${check.detail}` : ''
    await alert(`⚠️ PokePlay check "${check.name}" is failing${detail}`)
    state.failing[check.name] = nowSec()
  }
}

for (const name of Object.keys(state.failing)) {
  if (!seen.has(name)) {
    await alert(`🟢 PokePlay check "${name}" recovered`)
    delete state.failing[name]
  }
}

saveState(state)

const summary = failing.length
  ? `DEGRADED (${failing.map((c) => c.name).join(', ')})`
  : 'ok'
console.log(
  `watchdog ${new Date().toISOString()} http=${status} ${summary}` +
    (body?.liveBattles !== undefined ? ` liveBattles=${body.liveBattles}` : ''),
)

process.exit(failing.length ? 1 : 0)
