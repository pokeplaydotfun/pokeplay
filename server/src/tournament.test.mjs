/**
 * Tournaments, end to end against a live server.
 *
 * Runs real players through real battles until one champion remains, then
 * checks the things that would quietly ruin a tournament: someone entering
 * twice, a non-admin creating one, a stranger playing someone else's fixture,
 * and a bracket that has to cope with a player count that is not a power of two.
 */
import assert from 'node:assert'
import { privateKeyToAccount } from 'viem/accounts'
import WebSocket from 'ws'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8093'
const WS = BASE.replace('http', 'ws')

let passed = 0
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`✓ ${name}`) } catch (e) {
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

const { body: dex } = await api('/api/pokedex')
const TEAM = ['pikachu', 'charizard', 'blastoise', 'venusaur', 'alakazam', 'snorlax'].map((n) => {
  const sp = dex.species.find((s) => s.name === n)
  return { speciesId: sp.id, moves: sp.moves.slice(0, 4) }
})

let seq = 0
async function player(label) {
  const account = privateKeyToAccount('0x' + (++seq).toString(16).padStart(64, '0'))
  const { body: n } = await api('/api/auth/nonce', {
    method: 'POST', body: JSON.stringify({ address: account.address }),
  })
  const signature = await account.signMessage({ message: n.message })
  const { body: v } = await api('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ address: account.address, nonce: n.nonce, signature }),
  })
  // Claim a username so nothing is blocked by the first-run gate.
  const { body: un } = await api('/api/username/nonce', {
    method: 'POST', headers: auth(v.token), body: JSON.stringify({ name: label }),
  })
  if (un?.message) {
    const sig = await account.signMessage({ message: un.message })
    await api('/api/username', {
      method: 'POST', headers: auth(v.token),
      body: JSON.stringify({ name: label, nonce: un.nonce, signature: sig }),
    })
  }
  const { body: t } = await api('/api/teams', {
    method: 'POST', headers: auth(v.token),
    body: JSON.stringify({ name: `${label} team`, slots: TEAM }),
  })
  return { account, token: v.token, address: account.address.toLowerCase(), teamId: t.id, label }
}

/** The admin is whichever address the server was started with. */
const ADMIN_INDEX = 1

function connect(token) {
  const sock = new WebSocket(`${WS}/ws?token=${token}`)
  const queue = []
  const waiters = []
  sock.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    const w = waiters.shift()
    if (w) w(m)
    else queue.push(m)
  })
  return {
    sock,
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
    send: (m) => sock.send(JSON.stringify(m)),
    close: () => sock.close(),
    open: new Promise((r, j) => { sock.on('open', () => r()); sock.on('error', j) }),
  }
}

/** Plays one fixture to completion, both sides driven. */
async function playMatch(a, b) {
  const sa = connect(a.token)
  const sb = connect(b.token)
  await Promise.all([sa.open, sb.open])
  let ended = null

  const drive = async (s) => {
    for (let i = 0; i < 800 && !ended; i++) {
      const m = await s.next()
      if (m.type === 'ended') { ended = m; return }
      if (m.type !== 'state' || m.state?.finished) continue
      if (m.state.mustReplace) {
        const idx = m.state.you.team.findIndex((x) => !x.fainted)
        if (idx >= 0) s.send({ type: 'action', action: { kind: 'switch', index: idx } })
        continue
      }
      const active = m.state.you.team[m.state.you.active]
      const mv = active?.moves.findIndex((x) => x.pp > 0)
      s.send({ type: 'action', action: { kind: 'move', index: mv >= 0 ? mv : 0 } })
    }
  }

  await Promise.race([
    Promise.all([drive(sa), drive(sb)]),
    new Promise((_, j) => setTimeout(() => j(new Error('match timed out')), 90_000)),
  ])
  sa.close()
  sb.close()
  return ended
}

/* ------------------------------------------------------------------ */

const players = []
for (let i = 0; i < 8; i++) players.push(await player(`tp${i}`))
const admin = players[ADMIN_INDEX]
const byAddress = new Map(players.map((p) => [p.address, p]))

let tid

await check('only an admin can create a tournament', async () => {
  const outsider = players.find((p) => p.address !== admin.address)
  const denied = await api('/api/tournaments', {
    method: 'POST', headers: auth(outsider.token),
    body: JSON.stringify({ name: 'Not allowed', maxPlayers: 8, entryFeeWei: '0' }),
  })
  assert.strictEqual(denied.status, 403, JSON.stringify(denied.body))

  const made = await api('/api/tournaments', {
    method: 'POST', headers: auth(admin.token),
    body: JSON.stringify({ name: 'Launch Cup', maxPlayers: 8, entryFeeWei: '0' }),
  })
  assert.strictEqual(made.status, 200, JSON.stringify(made.body))
  tid = made.body.id
})

await check('a paid tournament is refused while no pool is configured', async () => {
  // With no TOURNAMENT_POOL_ADDRESS on this test server, paidEntryAvailable() is
  // false, so a paid tournament cannot be created — there is nowhere to hold the
  // fees.
  const r = await api('/api/tournaments', {
    method: 'POST', headers: auth(admin.token),
    body: JSON.stringify({ name: 'Paid Cup', maxPlayers: 8, entryFeeWei: '10000000000000000' }),
  })
  assert.strictEqual(r.status, 400, JSON.stringify(r.body))
  assert.match(r.body.error, /not (available|configured)/i)
})

await check('players sign up, and cannot sign up twice', async () => {
  for (const p of players) {
    const r = await api(`/api/tournaments/${tid}/join`, {
      method: 'POST', headers: auth(p.token), body: JSON.stringify({ teamId: p.teamId }),
    })
    assert.strictEqual(r.status, 200, `${p.label}: ${JSON.stringify(r.body)}`)
  }
  const again = await api(`/api/tournaments/${tid}/join`, {
    method: 'POST', headers: auth(players[0].token),
    body: JSON.stringify({ teamId: players[0].teamId }),
  })
  assert.strictEqual(again.status, 409, 'a double entry was allowed')

  const { body } = await api(`/api/tournaments/${tid}`)
  assert.strictEqual(body.players.length, 8)
})

await check('a full tournament refuses further entries', async () => {
  const extra = await player('tpextra')
  const r = await api(`/api/tournaments/${tid}/join`, {
    method: 'POST', headers: auth(extra.token), body: JSON.stringify({ teamId: extra.teamId }),
  })
  assert.strictEqual(r.status, 409, `expected full, got ${JSON.stringify(r.body)}`)
})

await check('a player can withdraw before it starts', async () => {
  const p = players[7]
  await api(`/api/tournaments/${tid}/leave`, { method: 'POST', headers: auth(p.token) })
  let { body } = await api(`/api/tournaments/${tid}`)
  assert.strictEqual(body.players.length, 7, 'withdrawal did not take')
  // Re-enter so the bracket is a clean 8.
  await api(`/api/tournaments/${tid}/join`, {
    method: 'POST', headers: auth(p.token), body: JSON.stringify({ teamId: p.teamId }),
  })
  ;({ body } = await api(`/api/tournaments/${tid}`))
  assert.strictEqual(body.players.length, 8)
})

await check('starting builds the whole bracket', async () => {
  const r = await api(`/api/tournaments/${tid}/start`, { method: 'POST', headers: auth(admin.token) })
  assert.strictEqual(r.status, 200, JSON.stringify(r.body))

  const { body } = await api(`/api/tournaments/${tid}`)
  assert.strictEqual(body.status, 'running')
  assert.strictEqual(body.rounds, 3)
  assert.strictEqual(body.matches.length, 7, `8 players should make 7 matches, got ${body.matches.length}`)
  assert.strictEqual(body.matches.filter((m) => m.round === 1 && m.status === 'ready').length, 4)
})

await check('nobody can play a fixture they are not in', async () => {
  const outsider = await player('tpoutsider')
  const r = await api(`/api/tournaments/${tid}/play`, {
    method: 'POST', headers: auth(outsider.token),
  })
  assert.ok(r.status >= 400, `an outsider got a room: ${JSON.stringify(r.body)}`)
})

await check('the tournament plays through to a single champion', async () => {
  for (let guard = 0; guard < 20; guard++) {
    const { body } = await api(`/api/tournaments/${tid}`)
    if (body.status === 'finished') break

    const ready = body.matches.filter((m) => m.status === 'ready' && m.p0 && m.p1)
    assert.ok(ready.length > 0, `nothing playable but not finished: ${JSON.stringify(body.matches)}`)

    for (const m of ready) {
      const a = byAddress.get(m.p0)
      const b = byAddress.get(m.p1)
      const start = await api(`/api/tournaments/${tid}/play`, { method: 'POST', headers: auth(a.token) })
      assert.strictEqual(start.status, 200, `could not start: ${JSON.stringify(start.body)}`)
      const ended = await playMatch(a, b)
      assert.ok(ended, 'match produced no result')
    }
  }

  const { body } = await api(`/api/tournaments/${tid}`)
  assert.strictEqual(body.status, 'finished', `still ${body.status}`)
  assert.ok(body.winner, 'no champion recorded')
  assert.ok(byAddress.has(body.winner), 'the champion was not an entrant')

  // Every match resolved, and exactly one final.
  assert.strictEqual(body.matches.filter((m) => m.status !== 'done').length, 0)
  const finals = body.matches.filter((m) => m.round === 3)
  assert.strictEqual(finals.length, 1)
  assert.strictEqual(finals[0].winner, body.winner)
  console.log(`      champion: ${body.winnerName ?? body.winner}`)
})

await check('an odd player count still resolves, using byes', async () => {
  const made = await api('/api/tournaments', {
    method: 'POST', headers: auth(admin.token),
    body: JSON.stringify({ name: 'Odd Cup', maxPlayers: 8, entryFeeWei: '0' }),
  })
  const oddId = made.body.id
  const five = players.slice(0, 5)
  for (const p of five) {
    await api(`/api/tournaments/${oddId}/join`, {
      method: 'POST', headers: auth(p.token), body: JSON.stringify({ teamId: p.teamId }),
    })
  }
  await api(`/api/tournaments/${oddId}/start`, { method: 'POST', headers: auth(admin.token) })

  const { body } = await api(`/api/tournaments/${oddId}`)
  assert.strictEqual(body.rounds, 3, '5 players needs a bracket of 8')
  // Three players get byes, which must already be resolved.
  const done = body.matches.filter((m) => m.status === 'done')
  assert.strictEqual(done.length, 3, `expected 3 byes settled, got ${done.length}`)
  assert.ok(done.every((m) => m.winner), 'a bye produced no winner')
})

await check('a hidden-wallet champion and entrant are not leaked on the tournament page', async () => {
  // Take the finished 4-player tournament (tid) and hide the champion's wallet.
  const before = await api(`/api/tournaments/${tid}`)
  const championAddr = before.body.winner
  assert.ok(championAddr, 'no champion to test with')
  const champion = byAddress.get(championAddr)
  assert.ok(champion, 'champion is not a known player')

  const priv = await api('/api/me/privacy', {
    method: 'POST', headers: auth(champion.token), body: JSON.stringify({ hideWallet: true }),
  })
  assert.strictEqual(priv.status, 200)
  assert.strictEqual(priv.body.hideWallet, true)

  // As a stranger (no auth): the raw wallet must appear nowhere.
  const { body: pub } = await api(`/api/tournaments/${tid}`)
  const blob = JSON.stringify(pub).toLowerCase()
  assert.ok(!blob.includes(championAddr.toLowerCase()), 'champion wallet leaked in the public view')

  assert.strictEqual(pub.winner, null, 'hidden champion address was sent to the public')
  assert.strictEqual(pub.winnerHidden, true, 'hidden champion not flagged hidden')
  assert.strictEqual(pub.hasWinner, true, 'a champion exists but hasWinner was false')
  assert.ok(pub.winnerName, 'the champion username should still show')
  assert.strictEqual(pub.winnerPayout, null, 'a stranger was given the payout wallet')

  // The champion is still listed as an entrant, by name, with no address.
  const entry = pub.players.find((p) => p.hidden)
  assert.ok(entry, 'hidden entrant missing from the list')
  assert.strictEqual(entry.address, null, 'hidden entrant address leaked')
  assert.ok(entry.name, 'hidden entrant lost their name')

  // The bracket still resolves: the final is decided and exactly one side won.
  const final = pub.matches.find((m) => m.round === pub.rounds)
  assert.ok(final && final.decided, 'the final should be decided')
  assert.strictEqual(Number(final.p0Won) + Number(final.p1Won), 1, 'exactly one finalist should have won')

  // The admin DOES get the real wallet, for the manual prize payout.
  const asAdmin = await api(`/api/tournaments/${tid}`, { headers: auth(admin.token) })
  assert.strictEqual(
    asAdmin.body.winnerPayout?.toLowerCase(), championAddr.toLowerCase(),
    'admin should see the real champion wallet for payout',
  )

  // The champion sees their OWN address, so their prize-claim panel still works.
  const asSelf = await api(`/api/tournaments/${tid}`, { headers: auth(champion.token) })
  assert.strictEqual(
    asSelf.body.winner?.toLowerCase(), championAddr.toLowerCase(),
    'a hidden champion should still see their own address',
  )
})

console.log(`\n${passed} tournament checks passed${process.exitCode ? ' (with failures)' : ''}`)
process.exit(process.exitCode ?? 0)
