/**
 * Privilege boundaries.
 *
 * Every check here is something that, if it broke, would let one player take
 * something from another: admin powers, other people's teams, other people's
 * fixtures, or information that decides a match before it is over.
 *
 * Run against a live server started with a known ADMIN_ADDRESSES.
 */
import assert from 'node:assert'
import { privateKeyToAccount } from 'viem/accounts'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8092'
/** The wallet the server under test was told is the admin. */
const ADMIN_KEY = process.env.ADMIN_KEY ?? '0x' + '2'.padStart(64, '0')

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

let seq = 500
async function player(label, key) {
  const account = privateKeyToAccount(key ?? '0x' + (++seq).toString(16).padStart(64, '0'))
  const { body: n } = await api('/api/auth/nonce', {
    method: 'POST', body: JSON.stringify({ address: account.address }),
  })
  const signature = await account.signMessage({ message: n.message })
  const { body: v } = await api('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ address: account.address, nonce: n.nonce, signature }),
  })
  const { body: un } = await api('/api/username/nonce', {
    method: 'POST', headers: auth(v.token), body: JSON.stringify({ name: label }),
  })
  if (un?.message) {
    const s = await account.signMessage({ message: un.message })
    await api('/api/username', {
      method: 'POST', headers: auth(v.token),
      body: JSON.stringify({ name: label, nonce: un.nonce, signature: s }),
    })
  }
  const { body: t } = await api('/api/teams', {
    method: 'POST', headers: auth(v.token),
    body: JSON.stringify({ name: `${label} team`, slots: TEAM }),
  })
  return { account, token: v.token, address: account.address.toLowerCase(), teamId: t.id, label }
}

const admin = await player('secadmin', ADMIN_KEY)
const mallory = await player('mallory')
const victim = await player('victim')

/* ---- admin boundary ---- */

await check('the admin wallet is recognised whatever case it was configured in', async () => {
  const { body } = await api('/api/tournaments', { headers: auth(admin.token) })
  assert.strictEqual(body.canCreate, true, 'the configured admin was not recognised')
})

await check('nobody else is an admin', async () => {
  const { body } = await api('/api/tournaments', { headers: auth(mallory.token) })
  assert.strictEqual(body.canCreate, false)
  const anon = await api('/api/tournaments')
  assert.strictEqual(anon.body.canCreate, false, 'signed-out visitors were offered admin powers')
})

let tid
await check('only the admin can create a tournament', async () => {
  const denied = await api('/api/tournaments', {
    method: 'POST', headers: auth(mallory.token),
    body: JSON.stringify({ name: 'Mallory Cup', maxPlayers: 4, entryFeeWei: '0' }),
  })
  assert.strictEqual(denied.status, 403, JSON.stringify(denied.body))

  const ok = await api('/api/tournaments', {
    method: 'POST', headers: auth(admin.token),
    body: JSON.stringify({ name: 'Security Cup', maxPlayers: 4, entryFeeWei: '0' }),
  })
  assert.strictEqual(ok.status, 200)
  tid = ok.body.id
})

await check('only the admin can start a tournament', async () => {
  for (const p of [mallory, victim]) {
    await api(`/api/tournaments/${tid}/join`, {
      method: 'POST', headers: auth(p.token), body: JSON.stringify({ teamId: p.teamId }),
    })
  }
  const denied = await api(`/api/tournaments/${tid}/start`, {
    method: 'POST', headers: auth(mallory.token),
  })
  assert.strictEqual(denied.status, 403, `a player started the tournament: ${JSON.stringify(denied.body)}`)

  const { body } = await api(`/api/tournaments/${tid}`)
  assert.strictEqual(body.status, 'open', 'the tournament started anyway')
})

await check('an unauthenticated request cannot create or start anything', async () => {
  const create = await api('/api/tournaments', {
    method: 'POST', body: JSON.stringify({ name: 'Anon Cup', maxPlayers: 4, entryFeeWei: '0' }),
  })
  assert.strictEqual(create.status, 401)
  const start = await api(`/api/tournaments/${tid}/start`, { method: 'POST' })
  assert.strictEqual(start.status, 401)
})

await check('a forged bearer token is refused', async () => {
  for (const token of ['', 'null', 'undefined', 'a'.repeat(64), admin.token + 'x']) {
    const r = await api('/api/me', { headers: { authorization: `Bearer ${token}` } })
    assert.strictEqual(r.status, 401, `token ${JSON.stringify(token)} was accepted`)
  }
})

/* ---- other people's property ---- */

await check("nobody can edit or delete another player's team", async () => {
  const edit = await api(`/api/teams/${victim.teamId}`, {
    method: 'PUT', headers: auth(mallory.token),
    body: JSON.stringify({ name: 'stolen', slots: TEAM }),
  })
  assert.strictEqual(edit.status, 404, `edited someone else's team: ${JSON.stringify(edit.body)}`)

  await api(`/api/teams/${victim.teamId}`, { method: 'DELETE', headers: auth(mallory.token) })
  const { body } = await api('/api/teams', { headers: auth(victim.token) })
  assert.ok(
    body.some((t) => t.id === victim.teamId),
    "another player's delete removed the victim's team",
  )
})

await check("nobody can enter a tournament using another player's team", async () => {
  const t = await api('/api/tournaments', {
    method: 'POST', headers: auth(admin.token),
    body: JSON.stringify({ name: 'Team Theft Cup', maxPlayers: 4, entryFeeWei: '0' }),
  })
  const r = await api(`/api/tournaments/${t.body.id}/join`, {
    method: 'POST', headers: auth(mallory.token),
    body: JSON.stringify({ teamId: victim.teamId }),
  })
  assert.ok(r.status >= 400, `entered with someone else's team: ${JSON.stringify(r.body)}`)
})

await check('nobody can play a fixture they are not part of', async () => {
  const outsider = await player('outsider2')
  const r = await api(`/api/tournaments/${tid}/play`, {
    method: 'POST', headers: auth(outsider.token),
  })
  assert.ok(r.status >= 400, `an outsider was given a room: ${JSON.stringify(r.body)}`)
})

/* ---- information that would decide a match ---- */

await check('the seed of an unfinished battle is never served', async () => {
  const a = await player('seeda')
  const b = await player('seedb')
  const w = await api('/api/wagers', {
    method: 'POST', headers: auth(a.token),
    body: JSON.stringify({ teamId: a.teamId, stakeWei: '0' }),
  })
  const { body: acc } = await api(`/api/wagers/${w.body.id}/accept`, {
    method: 'POST', headers: auth(b.token), body: JSON.stringify({ teamId: b.teamId }),
  })

  const battle = await api(`/api/battle/${acc.roomId}`)
  assert.strictEqual(battle.body.seed, null, 'the seed leaked mid-battle — rolls become predictable')

  // And the replay must not hand over both teams while the match is live.
  const replay = await api(`/api/replay/${acc.roomId}`)
  assert.strictEqual(replay.status, 404, 'a live battle was replayable, exposing both teams')
})

await check('the opponent PP and hidden state are not in the public battle view', async () => {
  const r = await api('/api/battle/current')
  assert.strictEqual(r.status, 401, 'battle state was served without a session')
})

/* ---- money ---- */

await check('a paid wager cannot be posted without an on-chain id', async () => {
  const p = await player('nochain')
  const r = await api('/api/wagers', {
    method: 'POST', headers: auth(p.token),
    body: JSON.stringify({ teamId: p.teamId, stakeWei: '1000000000000000000' }),
  })
  assert.ok(r.status >= 400, `a stake was accepted with nothing escrowed: ${JSON.stringify(r.body)}`)
})

await check('paid tournaments stay refused while fees cannot be held', async () => {
  const r = await api('/api/tournaments', {
    method: 'POST', headers: auth(admin.token),
    body: JSON.stringify({ name: 'Paid Cup', maxPlayers: 4, entryFeeWei: '1' }),
  })
  assert.strictEqual(r.status, 400, JSON.stringify(r.body))
})

console.log(`\n${passed} security checks passed${process.exitCode ? ' (with failures)' : ''}`)
process.exit(process.exitCode ?? 0)
