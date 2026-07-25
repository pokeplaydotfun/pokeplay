/**
 * Matchmaking, against a live server.
 *
 * The race matters: two people hitting "find a match" at the same moment must
 * end up in one battle together, not two queues waiting for each other.
 *
 * Run with a server on BASE (see npm run test:queue).
 */
import assert from 'node:assert'
import { privateKeyToAccount } from 'viem/accounts'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8097'

let passed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed++
    console.log(`✓ ${name}`)
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`)
    process.exitCode = 1
  }
}

const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const auth = (t) => ({ authorization: `Bearer ${t}` })

async function login(pk) {
  const account = privateKeyToAccount(pk)
  const { body: n } = await api('/api/auth/nonce', {
    method: 'POST',
    body: JSON.stringify({ address: account.address }),
  })
  const signature = await account.signMessage({ message: n.message })
  const { body: v } = await api('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ address: account.address, nonce: n.nonce, signature }),
  })
  assert.ok(v?.token, `login failed: ${JSON.stringify(v)}`)
  return { token: v.token, address: account.address.toLowerCase() }
}

const { body: dex } = await api('/api/pokedex')
const team = ['pikachu', 'charizard', 'blastoise', 'venusaur', 'alakazam', 'snorlax'].map((n) => {
  const sp = dex.species.find((s) => s.name === n)
  return { speciesId: sp.id, moves: sp.moves.slice(0, 4) }
})

async function player(pk, name) {
  const who = await login(pk)
  const { body } = await api('/api/teams', {
    method: 'POST',
    headers: auth(who.token),
    body: JSON.stringify({ name, slots: team }),
  })
  return { ...who, teamId: body.id, name }
}

const key = (n) => ('0x' + String(n).repeat(2).padStart(64, 'a')).slice(0, 66)

const alice = await player(key(11), 'alice')
const bob = await player(key(22), 'bob')
const carol = await player(key(33), 'carol')

const join = (who) =>
  api('/api/queue/join', {
    method: 'POST',
    headers: auth(who.token),
    body: JSON.stringify({ teamId: who.teamId }),
  })

const status = (who) => api('/api/queue/status', { headers: auth(who.token) })
const leave = (who) => api('/api/queue/leave', { method: 'POST', headers: auth(who.token) })

/* ------------------------------------------------------------------ */

await check('the first to arrive waits', async () => {
  const r = await join(alice)
  assert.strictEqual(r.status, 200, JSON.stringify(r.body))
  assert.strictEqual(r.body.kind, 'queued', JSON.stringify(r.body))
})

await check('the second to arrive is paired immediately', async () => {
  const r = await join(bob)
  assert.strictEqual(r.body.kind, 'matched', JSON.stringify(r.body))
  assert.ok(r.body.roomId, 'no room id')
  assert.strictEqual(r.body.opponent, alice.address)
})

await check('the waiting player is told where to go on their next poll', async () => {
  const r = await status(alice)
  assert.strictEqual(r.body.kind, 'matched', JSON.stringify(r.body))
  assert.ok(r.body.roomId)
})

await check('both players land in the SAME battle', async () => {
  const a = await status(alice)
  const b = await status(bob)
  // Alice's room was consumed above; both should now resolve to their active
  // battle rather than to two different rooms.
  const roomA = a.body.roomId
  const roomB = b.body.roomId
  assert.ok(roomA && roomB, `${JSON.stringify(a.body)} / ${JSON.stringify(b.body)}`)
  assert.strictEqual(roomA, roomB, 'players were put in different battles')
})

await check('someone already battling cannot queue', async () => {
  const r = await join(alice)
  assert.ok(r.status >= 400, `queued while in a battle: ${JSON.stringify(r.body)}`)
})

await check('a lone player can leave and is no longer queued', async () => {
  await join(carol)
  const before = await status(carol)
  assert.strictEqual(before.body.kind, 'queued')
  await leave(carol)
  const after = await status(carol)
  assert.strictEqual(after.body.kind, 'idle', JSON.stringify(after.body))
})

await check('two simultaneous joins produce exactly one battle', async () => {
  const dave = await player(key(44), 'dave')
  const erin = await player(key(55), 'erin')

  const [d, e] = await Promise.all([join(dave), join(erin)])
  const kinds = [d.body.kind, e.body.kind].sort()
  assert.deepStrictEqual(
    kinds, ['matched', 'queued'],
    `both raced to the same state: ${JSON.stringify([d.body, e.body])}`,
  )

  const rooms = new Set()
  for (const who of [dave, erin]) {
    const s = await status(who)
    assert.ok(s.body.roomId, `${who.name} has no room: ${JSON.stringify(s.body)}`)
    rooms.add(s.body.roomId)
  }
  assert.strictEqual(rooms.size, 1, `expected one shared room, got ${rooms.size}`)
})

await check('the queue size is reported for the lobby', async () => {
  const frank = await player(key(66), 'frank')
  await join(frank)
  const { body } = await api('/api/stats')
  assert.ok(body.queued >= 1, `stats reported queued=${body.queued}`)
  await leave(frank)
})

console.log(`\n${passed} queue checks passed${process.exitCode ? ' (with failures)' : ''}`)
process.exit(process.exitCode ?? 0)
