/**
 * Creates two signed-in players, saves them teams, posts a free wager and has
 * the second player accept it — leaving a live battle to open in the browser.
 *
 * Prints the session tokens and room id. Local development only.
 */
import { privateKeyToAccount } from 'viem/accounts'
import { anvilKey } from './dry-run/anvil.mjs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8090'

const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`)
  return body
}

async function login(pk) {
  const account = privateKeyToAccount(pk)
  const n = await api('/api/auth/nonce', {
    method: 'POST',
    body: JSON.stringify({ address: account.address }),
  })
  const signature = await account.signMessage({ message: n.message })
  const v = await api('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ address: account.address, nonce: n.nonce, signature }),
  })
  return { token: v.token, address: account.address }
}

const auth = (t) => ({ authorization: `Bearer ${t}` })

const dex = await api('/api/pokedex')
const pick = (name, moves) => {
  const sp = dex.species.find((s) => s.name === name)
  if (!sp) throw new Error(`no species ${name}`)
  const legal = moves.filter((m) => sp.moves.includes(m))
  // Top up to 4 moves from whatever the species can legally learn.
  for (const m of sp.moves) {
    if (legal.length >= 4) break
    if (!legal.includes(m)) legal.push(m)
  }
  return { speciesId: sp.id, moves: legal.slice(0, 4) }
}

const teamA = [
  pick('charizard', ['flamethrower', 'earthquake', 'dragon-claw', 'air-slash']),
  pick('blastoise', ['surf', 'ice-beam', 'body-slam', 'bite']),
  pick('venusaur', ['sludge-bomb', 'giga-drain', 'sleep-powder', 'body-slam']),
  pick('alakazam', ['psychic', 'shadow-ball', 'thunder-punch', 'calm-mind']),
  pick('snorlax', ['body-slam', 'earthquake', 'crunch', 'ice-punch']),
  pick('gengar', ['shadow-ball', 'sludge-bomb', 'thunderbolt', 'dazzling-gleam']),
]

const teamB = [
  pick('pikachu', ['thunderbolt', 'surf', 'iron-tail', 'quick-attack']),
  pick('machamp', ['cross-chop', 'earthquake', 'rock-slide', 'fire-punch']),
  pick('lapras', ['surf', 'ice-beam', 'thunderbolt', 'body-slam']),
  pick('arcanine', ['flamethrower', 'crunch', 'wild-charge', 'extreme-speed']),
  pick('golem', ['earthquake', 'rock-slide', 'body-slam', 'fire-punch']),
  pick('mewtwo', ['psychic', 'ice-beam', 'thunderbolt', 'aura-sphere']),
]

// anvil test accounts #1 and #5, derived rather than hard-coded (see anvil.mjs).
const A = anvilKey(1)
const B = anvilKey(5)

const alice = await login(A)
const bob = await login(B)

await api('/api/me/name', {
  method: 'POST', headers: auth(alice.token), body: JSON.stringify({ name: 'Ash' }),
})
await api('/api/me/name', {
  method: 'POST', headers: auth(bob.token), body: JSON.stringify({ name: 'Gary' }),
})

const tA = await api('/api/teams', {
  method: 'POST', headers: auth(alice.token),
  body: JSON.stringify({ name: 'Kanto Classics', slots: teamA }),
})
const tB = await api('/api/teams', {
  method: 'POST', headers: auth(bob.token),
  body: JSON.stringify({ name: 'Rival Squad', slots: teamB }),
})

const w = await api('/api/wagers', {
  method: 'POST', headers: auth(alice.token),
  body: JSON.stringify({ teamId: tA.id, stakeWei: '0' }),
})

const { roomId } = await api(`/api/wagers/${w.id}/accept`, {
  method: 'POST', headers: auth(bob.token),
  body: JSON.stringify({ teamId: tB.id }),
})

// A couple of spare open wagers so the board is not empty.
const spare = await login('0x' + 'a'.repeat(63) + '7')
await api('/api/me/name', {
  method: 'POST', headers: auth(spare.token), body: JSON.stringify({ name: 'Brock' }),
})
const tS = await api('/api/teams', {
  method: 'POST', headers: auth(spare.token),
  body: JSON.stringify({ name: 'Rock Solid', slots: teamB }),
})
await api('/api/wagers', {
  method: 'POST', headers: auth(spare.token),
  body: JSON.stringify({ teamId: tS.id, stakeWei: '0' }),
})

console.log(JSON.stringify({
  roomId,
  aliceToken: alice.token,
  bobToken: bob.token,
  aliceAddress: alice.address,
}, null, 2))
