#!/usr/bin/env node
/**
 * Load test: N players sign in, queue up, get paired, and play real battles to
 * completion over websockets.
 *
 * This is not a benchmark for its own sake. The server holds every live battle
 * in memory in one process, so the questions that matter at launch are: how
 * many concurrent matches before turns start lagging, does the matchmaker still
 * pair correctly under a stampede, and does anything leak.
 *
 *   BASE=http://127.0.0.1:8096 PLAYERS=40 node scripts/loadtest.mjs
 */
import { privateKeyToAccount } from 'viem/accounts'
import WebSocket from 'ws'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8096'
const PLAYERS = Number(process.env.PLAYERS ?? 40)
const WS = BASE.replace('http', 'ws')

const t0 = Date.now()
const ms = () => Date.now() - t0

const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const auth = (t) => ({ authorization: `Bearer ${t}` })

const stats = {
  signInFail: 0,
  queueFail: 0,
  rateLimited: 0,
  battlesStarted: 0,
  battlesFinished: 0,
  actionsSent: 0,
  turnLatencies: [],
  errors: new Map(),
}

const note = (e) => {
  const k = String(e).slice(0, 120)
  stats.errors.set(k, (stats.errors.get(k) ?? 0) + 1)
}

/* ---- sign in ------------------------------------------------------ */

const { body: dex } = await api('/api/pokedex')
if (!dex?.species) throw new Error('could not load the pokedex — is the server up?')

const roster = ['pikachu', 'charizard', 'blastoise', 'venusaur', 'alakazam', 'snorlax']
const team = roster.map((n) => {
  const sp = dex.species.find((s) => s.name === n)
  return { speciesId: sp.id, moves: sp.moves.slice(0, 4) }
})

/**
 * Distinct test keys.
 *
 * Padding with '7' looked harmless and was not: 0x1 and 0x71 both pad to the
 * same 64 characters, so players collided onto one address and the second was
 * told it was already in a battle. Zero-padding is unambiguous.
 */
function keyFor(i) {
  return '0x' + (i + 1).toString(16).padStart(64, '0')
}

async function signIn(i) {
  const account = privateKeyToAccount(keyFor(i))
  const { body: n, status } = await api('/api/auth/nonce', {
    method: 'POST',
    body: JSON.stringify({ address: account.address }),
  })
  if (status === 429) { stats.rateLimited++; throw new Error('429 on nonce') }
  if (!n?.message) throw new Error(`nonce failed (${status})`)
  const signature = await account.signMessage({ message: n.message })
  const { body: v } = await api('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ address: account.address, nonce: n.nonce, signature }),
  })
  if (!v?.token) throw new Error('verify failed')
  const { body: t } = await api('/api/teams', {
    method: 'POST',
    headers: auth(v.token),
    body: JSON.stringify({ name: `p${i}`, slots: team }),
  })
  if (!t?.id) throw new Error('team save failed')
  return { i, token: v.token, teamId: t.id, address: account.address.toLowerCase() }
}

console.log(`signing in ${PLAYERS} players…`)
const players = []
for (const r of await Promise.allSettled(
  Array.from({ length: PLAYERS }, (_, i) => signIn(i)),
)) {
  if (r.status === 'fulfilled') players.push(r.value)
  else { stats.signInFail++; note(r.reason?.message ?? r.reason) }
}
console.log(`  ${players.length}/${PLAYERS} signed in  (${ms()}ms)`)

/* ---- stampede the queue ------------------------------------------- */

console.log('all joining the queue at once…')
const joinT = Date.now()
const joins = await Promise.allSettled(
  players.map((p) =>
    api('/api/queue/join', {
      method: 'POST',
      headers: auth(p.token),
      body: JSON.stringify({ teamId: p.teamId }),
    }).then((r) => {
      if (r.status === 429) stats.rateLimited++
      if (r.status !== 200) {
        stats.queueFail++
        note(`queue ${r.status}: ${r.body?.error ?? ''}`)
        throw new Error(`queue ${r.status}`)
      }
      return { p, r: r.body }
    }),
  ),
)
console.log(`  join burst took ${Date.now() - joinT}ms`)

const matchedNow = joins.filter((j) => j.status === 'fulfilled' && j.value.r.kind === 'matched')
const queuedNow = joins.filter((j) => j.status === 'fulfilled' && j.value.r.kind === 'queued')
console.log(`  ${matchedNow.length} matched immediately, ${queuedNow.length} queued`)

// Everyone still queued polls once to collect their room.
const rooms = new Map()
for (const j of matchedNow) rooms.set(j.value.p.i, j.value.r.roomId)

await Promise.allSettled(
  queuedNow.map(async (j) => {
    for (let k = 0; k < 20; k++) {
      const { body } = await api('/api/queue/status', { headers: auth(j.value.p.token) })
      if (body?.kind === 'matched') return rooms.set(j.value.p.i, body.roomId)
      await new Promise((r) => setTimeout(r, 250))
    }
    note('never paired')
  }),
)

const paired = [...rooms.values()]
const distinct = new Set(paired)
console.log(`  ${paired.length} players in ${distinct.size} rooms`)
if (paired.length && distinct.size !== Math.floor(paired.length / 2)) {
  console.log(`  ⚠ expected ${Math.floor(paired.length / 2)} rooms for ${paired.length} players`)
}

/* ---- play every battle to completion ------------------------------ */

console.log('playing all battles…')
const playT = Date.now()

function play(p) {
  return new Promise((resolve) => {
    const sock = new WebSocket(`${WS}/ws?token=${p.token}`)
    let lastSent = 0
    const done = (why) => { try { sock.close() } catch {} ; resolve(why) }
    const timer = setTimeout(() => done('timeout'), 180_000)

    sock.on('error', (e) => { note(`ws: ${e.message}`); clearTimeout(timer); done('error') })

    sock.on('message', (raw) => {
      let m
      try { m = JSON.parse(String(raw)) } catch { return }

      if (m.type === 'ended') {
        stats.battlesFinished++
        clearTimeout(timer)
        return done('ended')
      }
      if (m.type === 'error') { note(`server: ${m.error}`); return }
      if (m.type !== 'state') return

      if (lastSent) stats.turnLatencies.push(Date.now() - lastSent)
      if (m.state?.finished) return
      const you = m.state?.you
      if (!you) return

      if (m.state.mustReplace) {
        const idx = you.team.findIndex((x) => !x.fainted)
        if (idx >= 0) {
          lastSent = Date.now()
          sock.send(JSON.stringify({ type: 'action', action: { kind: 'switch', index: idx } }))
        }
        return
      }
      const active = you.team[you.active]
      const move = active?.moves.findIndex((mv) => mv.pp > 0)
      lastSent = Date.now()
      stats.actionsSent++
      sock.send(JSON.stringify({
        type: 'action',
        action: { kind: 'move', index: move >= 0 ? move : 0 },
      }))
    })
  })
}

const playing = players.filter((p) => rooms.has(p.i))
stats.battlesStarted = distinct.size
const outcomes = await Promise.all(playing.map(play))
const playMs = Date.now() - playT

/* ---- report -------------------------------------------------------- */

const lat = stats.turnLatencies.sort((a, b) => a - b)
const pct = (q) => (lat.length ? lat[Math.floor(lat.length * q)] : 0)

const { body: health } = await api('/api/health')

console.log(`
────────────────────────────────────────
players            ${players.length}/${PLAYERS}
sign-in failures   ${stats.signInFail}
rate limited (429) ${stats.rateLimited}
queue failures     ${stats.queueFail}
rooms created      ${stats.battlesStarted}
battles finished   ${stats.battlesFinished} of ${playing.length} sockets
outcomes           ${JSON.stringify(outcomes.reduce((a, o) => ({ ...a, [o]: (a[o] ?? 0) + 1 }), {}))}
play wall-clock    ${(playMs / 1000).toFixed(1)}s
actions sent       ${stats.actionsSent}  (${Math.round(stats.actionsSent / (playMs / 1000))}/s)
turn round-trip    p50 ${pct(0.5)}ms   p95 ${pct(0.95)}ms   p99 ${pct(0.99)}ms   max ${lat.at(-1) ?? 0}ms
health after       ${health?.ok ? 'ok' : JSON.stringify(health?.checks?.filter((c) => !c.ok))}
────────────────────────────────────────`)

if (stats.errors.size) {
  console.log('errors:')
  for (const [k, n] of [...stats.errors].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${String(n).padStart(4)}  ${k}`)
  }
}

const bad =
  stats.signInFail > 0 ||
  stats.queueFail > 0 ||
  stats.rateLimited > 0 ||
  stats.battlesFinished < playing.length
process.exit(bad ? 1 : 0)
