/**
 * End-to-end proof of the PAID TOURNAMENT path: the game server and the
 * PokePlayTournamentPool driven together, over real HTTP + WebSocket + chain.
 *
 * This is the thing the contract tests and the server tests each cannot show on
 * their own — that the server seats only players who paid the pool, and that the
 * signature it hands the champion is one the REAL contract accepts and pays on.
 *
 * A two-player tournament keeps it to a single battle while still exercising the
 * whole pipeline: on-chain join → server verifies the payment → bracket → battle
 * → server signs the winner → the pool honours the signature → winner withdraws.
 */
import { readFileSync } from 'node:fs'
import {
  account, api, auth, connect, eth, login, playOut, pub, step, summary, topUp,
  wallet, TREASURY_ADDRESS,
} from './lib.mjs'

const POOL = process.env.POOL_ADDRESS
if (!POOL) throw new Error('POOL_ADDRESS is required')

const { abi } = JSON.parse(
  readFileSync(new URL('../../contracts/out/PokePlayTournamentPool.sol/PokePlayTournamentPool.json', import.meta.url), 'utf8'),
)
const at = { address: POOL, abi }
const read = (functionName, args = []) => pub.readContract({ ...at, functionName, args })

async function send(who, functionName, args = [], value = 0n) {
  await topUp(account(who).address)
  const hash = await wallet(who).writeContract({ ...at, functionName, args, value })
  return pub.waitForTransactionReceipt({ hash })
}

const balanceOf = (addr) => pub.getBalance({ address: addr })
const ENTRY = eth('0.01')

async function soon(seconds = 86_400) {
  return (await pub.getBlock()).timestamp + BigInt(seconds)
}

/** Save a legal team for a signed-in player, return its id. */
async function saveTeam(who, dex) {
  const names = ['pikachu', 'charizard', 'blastoise', 'venusaur', 'alakazam', 'snorlax']
  const slots = names.map((n) => {
    const sp = dex.species.find((s) => s.name === n)
    return { speciesId: sp.id, moves: sp.moves.slice(0, 4), nature: 'adamant', ability: sp.abilities[0]?.name }
  })
  const r = await api('/api/teams', {
    method: 'POST', headers: auth(who.token), body: JSON.stringify({ name: `${who.name} squad`, slots }),
  })
  if (r.status !== 200) throw new Error(`team save failed: ${JSON.stringify(r.body)}`)
  return r.body.id
}

/* ------------------------------------------------------------------ */

console.log('\n— setup —')

await step('the server reports paid tournaments enabled, pointed at this pool', async () => {
  const r = await api('/api/tournaments/settlement/status')
  if (!r.body?.enabled) throw new Error('tournament settlement is not enabled on the server')
  if (r.body.pool.toLowerCase() !== POOL.toLowerCase()) {
    throw new Error(`server pool ${r.body.pool} != ${POOL}`)
  }
})

const admin = await step('the admin signs in', () => login('deployer'))
const alice = await step('alice signs in', () => login('alice'))
const bob = await step('bob signs in', () => login('bob'))

const { body: dex } = await api('/api/pokedex')
let aliceTeam
let bobTeam
await step('both players save a team', async () => {
  aliceTeam = await saveTeam(alice, dex)
  bobTeam = await saveTeam(bob, dex)
})

/* ------------------------------------------------------------------ */
/* create the pool tournament + the server tournament                  */
/* ------------------------------------------------------------------ */

console.log('\n— create —')

let onchainId
await step('the admin opens a tournament pool on chain', async () => {
  await send('deployer', 'createTournament', [ENTRY, 2, await soon()])
  onchainId = await read('tournamentCount')
})

let tid
await step('the admin creates the server tournament backed by that pool', async () => {
  const r = await api('/api/tournaments', {
    method: 'POST',
    headers: auth(admin.token),
    body: JSON.stringify({
      name: 'Paid Cup Dry Run',
      maxPlayers: 2,
      entryFeeWei: ENTRY.toString(),
      onchainId: onchainId.toString(),
    }),
  })
  if (r.status !== 200) throw new Error(`create failed: ${JSON.stringify(r.body)}`)
  tid = r.body.id
})

/* ------------------------------------------------------------------ */
/* joining: on-chain payment is required                               */
/* ------------------------------------------------------------------ */

console.log('\n— join (payment gated) —')

await step('joining WITHOUT paying the pool is refused', async () => {
  const r = await api(`/api/tournaments/${tid}/join`, {
    method: 'POST', headers: auth(alice.token), body: JSON.stringify({ teamId: aliceTeam }),
  })
  if (r.status !== 402) throw new Error(`expected 402, got ${r.status}: ${JSON.stringify(r.body)}`)
})

await step('after paying the pool on chain, the server seats the player', async () => {
  for (const [p, teamId] of [[alice, aliceTeam], [bob, bobTeam]]) {
    await send(p.name, 'joinTournament', [onchainId], ENTRY)
    if (!(await read('isEntrant', [onchainId, account(p.name).address]))) {
      throw new Error(`${p.name} did not register as an on-chain entrant`)
    }
    const r = await api(`/api/tournaments/${tid}/join`, {
      method: 'POST', headers: auth(p.token), body: JSON.stringify({ teamId }),
    })
    if (r.status !== 200) throw new Error(`${p.name} join failed: ${JSON.stringify(r.body)}`)
  }
  const held = await balanceOf(POOL)
  if (held < ENTRY * 2n) throw new Error(`pool holds ${held}, expected >= ${ENTRY * 2n}`)
})

/* ------------------------------------------------------------------ */
/* play it out                                                         */
/* ------------------------------------------------------------------ */

console.log('\n— play —')

let champion
await step('the admin starts it and the single match plays to a champion', async () => {
  const s = await api(`/api/tournaments/${tid}/start`, { method: 'POST', headers: auth(admin.token) })
  if (s.status !== 200) throw new Error(`start failed: ${JSON.stringify(s.body)}`)

  const play = await api(`/api/tournaments/${tid}/play`, { method: 'POST', headers: auth(alice.token) })
  if (play.status !== 200) throw new Error(`play failed: ${JSON.stringify(play.body)}`)

  const a = connect(alice.token)
  const b = connect(bob.token)
  await playOut(a, b)
  a.close()
  b.close()

  // Poll for the finished status the battle result feeds back into.
  for (let i = 0; i < 30; i++) {
    const { body } = await api(`/api/tournaments/${tid}`)
    if (body.status === 'finished' && body.winner) {
      champion = body.winner
      return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('tournament never reached a finished champion')
})

/* ------------------------------------------------------------------ */
/* settle: the server's signature must satisfy the real contract       */
/* ------------------------------------------------------------------ */

console.log('\n— settle —')

await step('health flags the finished tournament as an unsettled pot', async () => {
  // The run sets STUCK_SETTLEMENT_SECONDS=0, so a finished-but-unsettled paid
  // tournament trips the alarm at once — the condition the watchdog exists for.
  const r = await api('/api/health')
  if (r.status !== 503) throw new Error(`health returned ${r.status}, expected 503`)
  const bad = (r.body?.checks ?? []).filter((c) => !c.ok).map((c) => c.name)
  if (!bad.includes('tournament-settlements')) {
    throw new Error(`failing checks were ${JSON.stringify(bad)}, expected 'tournament-settlements'`)
  }
})

let settlement
await step('the server signs the champion as the winner', async () => {
  const r = await api(`/api/tournaments/${tid}/settlement`)
  if (r.status !== 200) throw new Error(`no signature: ${JSON.stringify(r.body)}`)
  settlement = r.body
  if (settlement.winner.toLowerCase() !== champion.toLowerCase()) {
    throw new Error(`server signed ${settlement.winner}, champion is ${champion}`)
  }
})

await step('the POOL accepts that signature and pays the champion the pot minus fee', async () => {
  const feeBps = await read('feeBps')
  const pot = ENTRY * 2n
  const expectedFee = (pot * BigInt(feeBps)) / 10000n
  const expectedPayout = pot - expectedFee

  const winner = settlement.winner
  const winnerBefore = await read('balances', [winner])
  const treasuryBefore = await read('balances', [TREASURY_ADDRESS])

  // Anyone can relay it; use a bystander (the admin) to prove the signature is
  // the authority, not the caller.
  await send('deployer', 'settle', [onchainId, winner, settlement.signature])

  const credited = (await read('balances', [winner])) - winnerBefore
  if (credited !== expectedPayout) throw new Error(`winner credited ${credited}, expected ${expectedPayout}`)
  const treasury = (await read('balances', [TREASURY_ADDRESS])) - treasuryBefore
  if (treasury !== expectedFee) throw new Error(`treasury credited ${treasury}, expected ${expectedFee}`)
  console.log(`      pot ${pot} → winner ${expectedPayout}, fee ${expectedFee} (${feeBps}bps)`)
})

await step('the champion withdraws and exactly that leaves the pool', async () => {
  const winner = settlement.winner
  const who = winner.toLowerCase() === account('alice').address.toLowerCase() ? 'alice' : 'bob'
  const owed = await read('balances', [winner])
  const poolBefore = await balanceOf(POOL)
  await send(who, 'withdraw')
  const left = poolBefore - (await balanceOf(POOL))
  if (left !== owed) throw new Error(`${left} left the pool, owed ${owed}`)
})

await step('the server refuses to re-sign a settled tournament', async () => {
  // The pool is SETTLED now, so the settlement endpoint must not hand out another
  // winner signature.
  const r = await api(`/api/tournaments/${tid}/settlement`)
  if (r.status === 200) throw new Error('the server re-signed an already-settled tournament')
})

await step('the reconciler records the settlement and health recovers', async () => {
  // The winner settled from their own wallet, so the server only learns by
  // looking. The tournament reconciler runs on a 30s timer; poll for it.
  const deadline = Date.now() + 60_000
  for (;;) {
    const r = await api('/api/health')
    const bad = (r.body?.checks ?? []).filter((c) => !c.ok).map((c) => c.name)
    if (r.status === 200 && !bad.includes('tournament-settlements')) return
    if (Date.now() > deadline) {
      throw new Error(`health still flags the tournament after settling: ${JSON.stringify(bad)}`)
    }
    await new Promise((res) => setTimeout(res, 2000))
  }
})

/* ------------------------------------------------------------------ */
/* a pot that never fills must not trap the money                      */
/* ------------------------------------------------------------------ */

console.log('\n— underfilled —')

let dudOnchain
let dudTid
// Wall clock, not `soon()`: anvil only mines on a transaction, so the latest
// block can be a minute stale after a polling step — and a deadline derived from
// it would already be in the past by the time the create is mined.
const dudDeadline = BigInt(Math.floor(Date.now() / 1000)) + 20n

await step('a paid tournament is opened that only one player joins', async () => {
  // Deliberately short: sign-ups close with one entrant, so it can never run.
  await send('deployer', 'createTournament', [ENTRY, 4, dudDeadline])
  dudOnchain = await read('tournamentCount')

  const r = await api('/api/tournaments', {
    method: 'POST',
    headers: auth(admin.token),
    body: JSON.stringify({
      name: 'Empty Cup',
      maxPlayers: 4,
      entryFeeWei: ENTRY.toString(),
      onchainId: dudOnchain.toString(),
      startAt: Math.floor(Date.now() / 1000) + 5,
    }),
  })
  if (r.status !== 200) throw new Error(`create failed: ${JSON.stringify(r.body)}`)
  dudTid = r.body.id

  await send('alice', 'joinTournament', [dudOnchain], ENTRY)
  const j = await api(`/api/tournaments/${dudTid}/join`, {
    method: 'POST', headers: auth(alice.token), body: JSON.stringify({ teamId: aliceTeam }),
  })
  if (j.status !== 200) throw new Error(`join failed: ${JSON.stringify(j.body)}`)
})

await step('sign-ups close, it does not start, and health flags the trapped pot', async () => {
  // The scheduler cannot start a one-player bracket and must not cancel a paid
  // one on its own (the money is on chain, not in the database), so it stays
  // open — which is exactly the condition worth paging someone about.
  const deadline = Date.now() + 60_000
  for (;;) {
    const r = await api('/api/health')
    const bad = (r.body?.checks ?? []).filter((c) => !c.ok)
    const hit = bad.find((c) => c.name === 'tournament-underfilled')
    if (hit) {
      if (!hit.detail?.includes(`#${dudTid}`)) throw new Error(`flagged, but not this one: ${hit.detail}`)
      const { body } = await api(`/api/tournaments/${dudTid}`)
      if (body.status !== 'open') throw new Error(`server status is ${body.status}, expected still open`)
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`health never flagged it; failing checks: ${JSON.stringify(bad.map((c) => c.name))}`)
    }
    await new Promise((r2) => setTimeout(r2, 2000))
  }
})

await step('the entrant cancels the pool themselves — no organizer needed', async () => {
  // The pool lets ANYONE cancel a tournament that is past its deadline and can
  // never run. Without that, a single entrant would be waiting on the organizer
  // to notice, or on the 24h settle timeout.
  //
  // The next block takes its timestamp from the wall clock, so the deadline has
  // to have actually passed before the cancel is sent.
  while (Math.floor(Date.now() / 1000) <= Number(dudDeadline)) {
    await new Promise((r) => setTimeout(r, 1000))
  }
  await send('alice', 'cancelTournament', [dudOnchain])
  const status = Number(await read('statusOf', [dudOnchain]))
  if (status !== 3) throw new Error(`pool status ${status}, expected REFUNDING(3)`)
})

await step('they claim the entry fee back and withdraw it', async () => {
  const addr = account('alice').address
  await send('alice', 'claimRefund', [dudOnchain])
  const owed = await read('balances', [addr])
  if (owed !== ENTRY) throw new Error(`credited ${owed}, expected ${ENTRY}`)

  const poolBefore = await balanceOf(POOL)
  await send('alice', 'withdraw')
  const left = poolBefore - (await balanceOf(POOL))
  if (left !== ENTRY) throw new Error(`${left} left the pool, expected ${ENTRY}`)
  if ((await read('balances', [addr])) !== 0n) throw new Error('the pool still owes them')
})

await step('the reconciler marks it cancelled and health recovers', async () => {
  // Nobody told the server: it has to notice the pool went REFUNDING by looking.
  const deadline = Date.now() + 90_000
  for (;;) {
    const { body } = await api(`/api/tournaments/${dudTid}`)
    const r = await api('/api/health')
    const bad = (r.body?.checks ?? []).filter((c) => !c.ok).map((c) => c.name)
    if (body.status === 'cancelled' && !bad.includes('tournament-underfilled')) return
    if (Date.now() > deadline) {
      throw new Error(`server says ${body.status}, failing checks ${JSON.stringify(bad)}`)
    }
    await new Promise((r2) => setTimeout(r2, 2000))
  }
})

/* ------------------------------------------------------------------ */

const ok = summary('paid tournament e2e')
process.exit(ok ? 0 : 1)
