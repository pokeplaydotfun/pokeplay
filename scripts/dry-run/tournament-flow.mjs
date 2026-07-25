/**
 * The tournament-pool dry run: the whole on-chain lifecycle against a real
 * deployed PokePlayTournamentPool and real transactions — create, several joins,
 * an arbiter-signed settlement with the pot maths checked on chain, a withdraw,
 * plus the timeout-refund and organizer-cancel paths.
 *
 * There is no game server in the loop yet (server wiring is the next step), so
 * the arbiter signature is produced right here with the arbiter key, exactly as
 * the server will. The point is to prove the contract that will hold real pooled
 * money behaves end to end with live transactions, not just in Foundry.
 */
import { readFileSync } from 'node:fs'
import {
  account, eth, pub, step, summary, topUp, wallet, RPC, TREASURY_ADDRESS,
} from './lib.mjs'

const POOL = process.env.POOL_ADDRESS
if (!POOL) throw new Error('POOL_ADDRESS is required')

const artifactPath = new URL(
  '../../contracts/out/PokePlayTournamentPool.sol/PokePlayTournamentPool.json',
  import.meta.url,
)
const { abi } = JSON.parse(readFileSync(artifactPath, 'utf8'))
const at = { address: POOL, abi }

const read = (functionName, args = []) => pub.readContract({ ...at, functionName, args })

async function send(who, functionName, args = [], value = 0n) {
  await topUp(account(who).address) // no-op unless FORK — see lib.mjs
  const hash = await wallet(who).writeContract({ ...at, functionName, args, value })
  return pub.waitForTransactionReceipt({ hash })
}

const balanceOf = (addr) => pub.getBalance({ address: addr })

/** Mirrors the contract's Status enum, in declaration order. */
const STATUS = { NONE: 0, OPEN: 1, SETTLED: 2, REFUNDING: 3 }

const rpc = (method, params = []) =>
  fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json())

async function soon(seconds = 86_400) {
  const block = await pub.getBlock()
  return block.timestamp + BigInt(seconds)
}

/** Sign a TournamentResult exactly as the server's arbiter will. */
async function signResult(id, winner) {
  const chainId = await pub.getChainId()
  const nonce = (await read('getTournament', [id])).nonce
  return wallet('arbiter').signTypedData({
    domain: { name: 'PokePlayTournamentPool', version: '1', chainId, verifyingContract: POOL },
    types: {
      TournamentResult: [
        { name: 'tournamentId', type: 'uint256' },
        { name: 'winner', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'TournamentResult',
    message: { tournamentId: id, winner, nonce },
  })
}

const ENTRY = eth('0.01')
// Four anvil accounts to act as entrants, plus a treasury/arbiter/deployer.
const PLAYERS = ['alice', 'bob', 'bob2', 'carol']

/* ------------------------------------------------------------------ */

console.log('\n— setup —')

await step('the server and the contract agree on the arbiter', async () => {
  const onChain = await read('arbiter')
  if (onChain.toLowerCase() !== account('arbiter').address.toLowerCase()) {
    throw new Error(`arbiter mismatch: contract ${onChain}, expected ${account('arbiter').address}`)
  }
})

/* ------------------------------------------------------------------ */
/* A. happy path — four join, one wins the pot                         */
/* ------------------------------------------------------------------ */

console.log('\n— A. four-player pool, winner takes it —')

let idA
await step('the organizer opens a tournament', async () => {
  const receipt = await send('deployer', 'createTournament', [ENTRY, 8, await soon()])
  idA = await read('tournamentCount')
  const t = await read('getTournament', [idA])
  if (t.entryFee !== ENTRY) throw new Error(`entryFee recorded as ${t.entryFee}`)
  if (Number(t.status) !== STATUS.OPEN) throw new Error(`status ${t.status}, expected OPEN`)
  console.log(`      tournament #${idA}, gas ${receipt.gasUsed}`)
})

await step('four players each pay the entry fee and are seated', async () => {
  for (const p of PLAYERS) {
    const before = await balanceOf(account(p).address)
    await send(p, 'joinTournament', [idA], ENTRY)
    const spent = before - (await balanceOf(account(p).address))
    if (spent < ENTRY) throw new Error(`${p} spent ${spent}, expected >= ${ENTRY}`)
    if (!(await read('isEntrant', [idA, account(p).address]))) {
      throw new Error(`${p} is not recorded as an entrant`)
    }
  }
  const t = await read('getTournament', [idA])
  if (t.playerCount !== 4) throw new Error(`playerCount ${t.playerCount}, expected 4`)
  const pot = await read('potOf', [idA])
  if (pot !== ENTRY * 4n) throw new Error(`pot ${pot}, expected ${ENTRY * 4n}`)
})

await step('the contract holds the whole pot', async () => {
  const held = await balanceOf(POOL)
  if (held < ENTRY * 4n) throw new Error(`contract holds ${held}, expected >= ${ENTRY * 4n}`)
})

await step('the arbiter signs the winner and the contract pays out correctly', async () => {
  const winner = account('carol').address
  const feeBps = await read('feeBps')
  const pot = ENTRY * 4n
  const expectedFee = (pot * BigInt(feeBps)) / 10000n
  const expectedPayout = pot - expectedFee

  const winnerBefore = await read('balances', [winner])
  const treasuryBefore = await read('balances', [TREASURY_ADDRESS])

  // A bystander relays the signed result — the signature is the authority.
  const sig = await signResult(idA, winner)
  await send('alice', 'settle', [idA, winner, sig])

  const credited = (await read('balances', [winner])) - winnerBefore
  if (credited !== expectedPayout) throw new Error(`winner credited ${credited}, expected ${expectedPayout}`)
  const treasury = (await read('balances', [TREASURY_ADDRESS])) - treasuryBefore
  if (treasury !== expectedFee) throw new Error(`treasury credited ${treasury}, expected ${expectedFee}`)
  const t = await read('getTournament', [idA])
  if (Number(t.status) !== STATUS.SETTLED) throw new Error(`status ${t.status}, expected SETTLED`)
  console.log(`      pot ${pot} → winner ${expectedPayout}, fee ${expectedFee} (${feeBps}bps)`)
})

await step('a losing entrant is owed nothing', async () => {
  const owed = await read('balances', [account('bob').address])
  if (owed !== 0n) throw new Error(`a loser was credited ${owed}`)
})

await step('the winner withdraws and exactly the pot-minus-fee leaves escrow', async () => {
  const winner = account('carol').address
  const owed = await read('balances', [winner])
  const escrowBefore = await balanceOf(POOL)
  await send('carol', 'withdraw')
  const left = escrowBefore - (await balanceOf(POOL))
  if (left !== owed) throw new Error(`${left} left the contract, owed ${owed}`)
  if ((await read('balances', [winner])) !== 0n) throw new Error('balance not cleared')
})

await step('the same tournament cannot be settled twice', async () => {
  const winner = account('carol').address
  let threw = null
  try {
    await send('alice', 'settle', [idA, winner, await signResult(idA, winner)])
  } catch (e) {
    threw = e
  }
  if (!threw) throw new Error('a settled tournament settled again')
})

/* ------------------------------------------------------------------ */
/* B. a non-entrant can never be named the winner                      */
/* ------------------------------------------------------------------ */

console.log('\n— B. the arbiter is bounded to entrants —')

await step('a signature for a non-entrant is refused', async () => {
  const receipt = await send('deployer', 'createTournament', [ENTRY, 8, await soon()])
  void receipt
  const id = await read('tournamentCount')
  for (const p of ['alice', 'bob']) await send(p, 'joinTournament', [id], ENTRY)

  // quickstart never joined; even a perfectly valid arbiter signature for them
  // must be rejected by the entrant check.
  const outsider = account('quickstart').address
  let threw = null
  try {
    await send('alice', 'settle', [id, outsider, await signResult(id, outsider)])
  } catch (e) {
    threw = e
  }
  if (!threw) throw new Error('the pot could be sent to a non-entrant')
})

/* ------------------------------------------------------------------ */
/* C. timeout refund, with no server and no owner                      */
/* ------------------------------------------------------------------ */

console.log('\n— C. timeout refund, server uninvolved —')

await step('after the timeout, every entrant reclaims exactly their fee', async () => {
  await send('deployer', 'createTournament', [ENTRY, 8, await soon()])
  const id = await read('tournamentCount')
  const entrants = ['alice', 'bob', 'bob2']
  for (const p of entrants) await send(p, 'joinTournament', [id], ENTRY)

  // Before the timeout, a refund is refused.
  let early = null
  try {
    await send('alice', 'claimRefund', [id])
  } catch (e) {
    early = e
  }
  if (!early) throw new Error('a refund was allowed before the timeout')

  // Jump past registrationDeadline + settleTimeout.
  const claimAt = await read('timeoutAt', [id])
  const block = await pub.getBlock()
  await rpc('evm_increaseTime', [Number(claimAt - block.timestamp) + 60])
  await rpc('evm_mine', [])

  for (const p of entrants) {
    const before = await read('balances', [account(p).address])
    await send(p, 'claimRefund', [id])
    const credited = (await read('balances', [account(p).address])) - before
    if (credited !== ENTRY) throw new Error(`${p} refunded ${credited}, expected ${ENTRY}`)
  }
  const t = await read('getTournament', [id])
  if (Number(t.status) !== STATUS.REFUNDING) throw new Error(`status ${t.status}, expected REFUNDING`)
})

/* ------------------------------------------------------------------ */
/* D. organizer cancels an unfilled tournament                         */
/* ------------------------------------------------------------------ */

console.log('\n— D. organizer cancel before the deadline —')

await step('the organizer calls it off and entrants reclaim their fee', async () => {
  await send('deployer', 'createTournament', [ENTRY, 8, await soon()])
  const id = await read('tournamentCount')
  await send('alice', 'joinTournament', [id], ENTRY)

  await send('deployer', 'cancelTournament', [id])
  const t = await read('getTournament', [id])
  if (Number(t.status) !== STATUS.REFUNDING) throw new Error(`status ${t.status}, expected REFUNDING`)

  const before = await read('balances', [account('alice').address])
  await send('alice', 'claimRefund', [id])
  const credited = (await read('balances', [account('alice').address])) - before
  if (credited !== ENTRY) throw new Error(`alice refunded ${credited}, expected ${ENTRY}`)
})

/* ------------------------------------------------------------------ */
/* E. a player leaves and gets their fee back; the pot shrinks          */
/* ------------------------------------------------------------------ */

console.log('\n— E. leave (unjoin + refund) —')

await step('a player leaves an open tournament and reclaims exactly their fee', async () => {
  await send('deployer', 'createTournament', [ENTRY, 8, await soon()])
  const id = await read('tournamentCount')
  for (const p of ['alice', 'bob', 'bob2']) await send(p, 'joinTournament', [id], ENTRY)
  if (Number((await read('getTournament', [id])).playerCount) !== 3) throw new Error('expected 3 entrants')

  const before = await read('balances', [account('bob').address])
  await send('bob', 'leaveTournament', [id])
  const credited = (await read('balances', [account('bob').address])) - before
  if (credited !== ENTRY) throw new Error(`bob got ${credited} back, expected ${ENTRY}`)
  if (await read('isEntrant', [id, account('bob').address])) throw new Error('bob is still an entrant')
  const t = await read('getTournament', [id])
  if (Number(t.playerCount) !== 2) throw new Error(`playerCount ${t.playerCount}, expected 2`)
  if ((await read('potOf', [id])) !== ENTRY * 2n) throw new Error('pot did not shrink to 2 entrants')
})

/* ------------------------------------------------------------------ */
/* F. organizer extends the registration deadline                      */
/* ------------------------------------------------------------------ */

console.log('\n— F. extend the deadline —')

await step('the organizer pushes the deadline out and joins reopen', async () => {
  const shortDeadline = await soon(120) // 2 minutes
  await send('deployer', 'createTournament', [ENTRY, 8, shortDeadline])
  const id = await read('tournamentCount')

  // Move past the original deadline: a join would now be refused.
  await rpc('evm_increaseTime', [300])
  await rpc('evm_mine', [])
  let closed = null
  try {
    await send('alice', 'joinTournament', [id], ENTRY)
  } catch (e) {
    closed = e
  }
  if (!closed) throw new Error('a join succeeded after the deadline, before extending')

  // Extend, then the same join goes through.
  const block = await pub.getBlock()
  await send('deployer', 'extendDeadline', [id, block.timestamp + 3600n])
  await send('alice', 'joinTournament', [id], ENTRY)
  if (!(await read('isEntrant', [id, account('alice').address]))) {
    throw new Error('alice could not join after the deadline was extended')
  }
})

/* ------------------------------------------------------------------ */

const ok = summary('tournament dry run')
process.exit(ok ? 0 : 1)
