/**
 * The dry run itself: every scenario from contracts/DRY-RUN.md, against a real
 * contract on anvil and a real server process.
 *
 * The point is to exercise the seam between the two — the contract tests and
 * the server tests both pass in isolation, and neither has ever checked that
 * the server signs something this contract will accept.
 */
import {
  api, artifact, auth, account, connect, eth, FORK, login, mustRevert, ownerWallet, playOut,
  pub, step, summary, topUp, wallet, IMPERSONATED_OWNER, TEAM_NAMES, TREASURY_ADDRESS,
} from './lib.mjs'

const ESCROW = process.env.ESCROW_ADDRESS
if (!ESCROW) throw new Error('ESCROW_ADDRESS is required')

const { abi } = artifact()
const at = { address: ESCROW, abi }

const read = (functionName, args = []) => pub.readContract({ ...at, functionName, args })

async function send(who, functionName, args = [], value = 0n) {
  await topUp(account(who).address) // no-op unless FORK — see lib.mjs
  const hash = await wallet(who).writeContract({ ...at, functionName, args, value })
  return pub.waitForTransactionReceipt({ hash })
}

/** Owner-only calls. Impersonated when running against a fork — see lib.mjs. */
async function ownerSend(functionName, args = []) {
  if (IMPERSONATED_OWNER) await topUp(IMPERSONATED_OWNER)
  const hash = await ownerWallet().writeContract({ ...at, functionName, args })
  return pub.waitForTransactionReceipt({ hash })
}

const balanceOf = (addr) => pub.getBalance({ address: addr })
const STAKE = eth('0.01')

/** Mirrors the contract's Status enum, in declaration order. */
const STATUS = { NONE: 0, OPEN: 1, ACTIVE: 2, SETTLED: 3, REFUNDED: 4, CANCELLED: 5 }

/**
 * Expiry must be derived from the CHAIN's clock, not the wall clock. Scenario C
 * fast-forwards the node, after which anything based on Date.now() is already
 * in the past and createWager reverts with ExpiryInPast.
 */
async function soon(seconds = 3600) {
  const block = await pub.getBlock()
  return block.timestamp + BigInt(seconds)
}

/* ------------------------------------------------------------------ */

console.log('\n— setup —')

const alice = await step('alice signs in', () => login('alice'))
const bob = await step('bob signs in', () => login('bob'))

const { body: dex } = await api('/api/pokedex')
const team = TEAM_NAMES.map((n) => {
  const sp = dex.species.find((s) => s.name === n)
  return {
    speciesId: sp.id,
    moves: sp.moves.slice(0, 4),
    nature: 'adamant',
    ability: sp.abilities[0]?.name,
  }
})

const saveTeam = async (who) => {
  const r = await api('/api/teams', {
    method: 'POST',
    headers: auth(who.token),
    body: JSON.stringify({ name: `${who.name} squad`, slots: team }),
  })
  if (r.status !== 200) throw new Error(`team save failed: ${JSON.stringify(r.body)}`)
  return r.body.id
}

const aliceTeam = await step('alice saves a team', () => saveTeam(alice))
const bobTeam = await step('bob saves a team', () => saveTeam(bob))

await step('the server agrees with the contract about domain and arbiter', async () => {
  const r = await api('/api/settlement/status')
  if (!r.body?.enabled) throw new Error('settlement is not enabled on the server')
  const onChain = await read('arbiter')
  if (onChain.toLowerCase() !== r.body.arbiter.toLowerCase()) {
    throw new Error(`arbiter mismatch: contract ${onChain}, server ${r.body.arbiter}`)
  }
})

/* ------------------------------------------------------------------ */
/* A. happy path                                                       */
/* ------------------------------------------------------------------ */

console.log('\n— A. happy path —')

const expiry = await soon()
let onchainId

await step('alice creates an on-chain wager and the stake leaves her wallet', async () => {
  const before = await balanceOf(account('alice').address)
  const receipt = await send('alice', 'createWager', [STAKE, expiry], STAKE)
  const after = await balanceOf(account('alice').address)
  const spent = before - after
  if (spent < STAKE) throw new Error(`only ${spent} wei left the wallet, expected >= ${STAKE}`)
  onchainId = await read('wagerCount')
  const w = await read('getWager', [onchainId])
  if (w.stake !== STAKE) throw new Error(`contract recorded stake ${w.stake}`)
  console.log(`      wager #${onchainId}, gas ${receipt.gasUsed}`)
})

let wagerId
await step('the wager is posted to the server', async () => {
  const r = await api('/api/wagers', {
    method: 'POST',
    headers: auth(alice.token),
    body: JSON.stringify({
      teamId: aliceTeam,
      stakeWei: STAKE.toString(),
      onchainId: onchainId.toString(),
    }),
  })
  if (r.status !== 200) throw new Error(`post failed: ${JSON.stringify(r.body)}`)
  wagerId = r.body.id
})

await step('bob accepts on chain and the contract holds both stakes', async () => {
  await send('bob', 'acceptWager', [onchainId], STAKE)
  const held = await pub.getBalance({ address: ESCROW })
  if (held < STAKE * 2n) throw new Error(`escrow holds ${held}, expected >= ${STAKE * 2n}`)
  const w = await read('getWager', [onchainId])
  if (Number(w.status) !== STATUS.ACTIVE) throw new Error(`status is ${w.status}, expected ACTIVE`)
})

let roomId
await step('bob accepts on the server, starting the battle', async () => {
  const r = await api(`/api/wagers/${wagerId}/accept`, {
    method: 'POST',
    headers: auth(bob.token),
    body: JSON.stringify({ teamId: bobTeam }),
  })
  if (r.status !== 200) throw new Error(`accept failed: ${JSON.stringify(r.body)}`)
  roomId = r.body.roomId
})

let winnerAddr
await step('the battle plays to a real finish', async () => {
  const a = connect(alice.token)
  const b = connect(bob.token)
  const ended = await playOut(a, b)
  a.close()
  b.close()
  if (ended.winner === null) throw new Error('drew; rerun for the happy path')
  winnerAddr = ended.winner === 0 ? alice.address : bob.address
  console.log(`      winner: ${ended.winner === 0 ? 'alice' : 'bob'}`)
})

await step('the pot shows as unclaimed while it is still escrowed', async () => {
  // The battle is over but nothing has touched the chain. The server used to
  // mark this 'settled' here, claiming money had moved when it had not.
  const onChain = await read('getWager', [onchainId])
  if (Number(onChain.status) !== STATUS.ACTIVE) {
    throw new Error(`chain says ${onChain.status}, expected still ACTIVE`)
  }

  const winnerIsAlice = winnerAddr.toLowerCase() === alice.address.toLowerCase()
  const who = winnerIsAlice ? alice : bob
  const loser = winnerIsAlice ? bob : alice

  const { body: owed } = await api('/api/me/unclaimed', { headers: auth(who.token) })
  if (!Array.isArray(owed) || owed.length !== 1) {
    throw new Error(`winner sees ${JSON.stringify(owed)}, expected one unclaimed pot`)
  }
  if (owed[0].onchainId !== onchainId.toString()) {
    throw new Error(`unclaimed points at wager ${owed[0].onchainId}, expected ${onchainId}`)
  }

  const { body: none } = await api('/api/me/unclaimed', { headers: auth(loser.token) })
  if (!Array.isArray(none) || none.length !== 0) {
    throw new Error(`the loser was told they have a pot to claim: ${JSON.stringify(none)}`)
  }

  // The banner's countdown comes from timeoutAt(), which the contract only
  // answers while the wager is ACTIVE — i.e. exactly while the banner is up.
  const at = await read('timeoutAt', [onchainId])
  const block = await pub.getBlock()
  if (Number(at) <= Number(block.timestamp)) {
    throw new Error(`timeoutAt ${at} is not in the future (now ${block.timestamp})`)
  }
  const timeout = await read('settleTimeout')
  if (Number(at) !== Number(onChain.acceptedAt) + Number(timeout)) {
    throw new Error(`timeoutAt ${at} != acceptedAt ${onChain.acceptedAt} + timeout ${timeout}`)
  }
})

let settlement
await step('health reports the unclaimed pot as a failing check', async () => {
  // The run sets STUCK_SETTLEMENT_SECONDS=0, so a pot that is unclaimed at all
  // trips the alarm. This is the condition the watchdog exists to catch: a
  // winner who never claims loses their winnings when the timeout refunds both.
  const r = await api('/api/health')
  if (r.status !== 503) throw new Error(`health returned ${r.status}, expected 503`)
  const bad = (r.body?.checks ?? []).filter((c) => !c.ok).map((c) => c.name)
  if (!bad.includes('settlements')) {
    throw new Error(`failing checks were ${JSON.stringify(bad)}, expected 'settlements'`)
  }
})

await step('the server signs the result', async () => {
  const r = await api(`/api/wagers/${wagerId}/settlement`)
  if (r.status !== 200) throw new Error(`no signature: ${JSON.stringify(r.body)}`)
  settlement = r.body
  if (settlement.kind !== 'win') throw new Error(`expected a win, got ${settlement.kind}`)
  if (settlement.winner.toLowerCase() !== winnerAddr.toLowerCase()) {
    throw new Error(`server named ${settlement.winner}, battle said ${winnerAddr}`)
  }
})

await step('the contract ACCEPTS that signature and pays out correctly', async () => {
  const feeBps = await read('feeBps')
  const pot = STAKE * 2n
  const expectedFee = (pot * BigInt(feeBps)) / 10000n
  const expectedWin = pot - expectedFee

  // Compare DELTAS, not absolutes: against a fork of mainnet the treasury
  // already holds real accrued fees, and an absolute check would read that
  // history as a failure.
  const winnerBefore = await read('balances', [settlement.winner])
  const treasuryBefore = await read('balances', [TREASURY_ADDRESS])

  await send('alice', 'settle', [onchainId, settlement.winner, settlement.signature])

  const credited = (await read('balances', [settlement.winner])) - winnerBefore
  if (credited !== expectedWin) {
    throw new Error(`winner credited ${credited}, expected ${expectedWin}`)
  }
  const treasury = (await read('balances', [TREASURY_ADDRESS])) - treasuryBefore
  if (treasury !== expectedFee) {
    throw new Error(`treasury credited ${treasury}, expected ${expectedFee}`)
  }
  const w = await read('getWager', [onchainId])
  if (Number(w.status) !== STATUS.SETTLED) throw new Error(`status ${w.status}, expected SETTLED`)
  console.log(`      pot ${pot} → winner ${expectedWin}, fee ${expectedFee} (${feeBps}bps)`)
})

await step('the winner withdraws and the ETH actually lands', async () => {
  const who = settlement.winner.toLowerCase() === alice.address.toLowerCase() ? 'alice' : 'bob'
  const owed = await read('balances', [settlement.winner])

  // Prove the payout by watching the ESCROW's balance, not the winner's wallet:
  // exactly `owed` must leave the contract, and the internal credit must clear.
  // This holds regardless of what gas the caller pays — which matters on a fork
  // where the L2 fee is not modelled (see lib.mjs). The winner's wallet is a
  // clean, checkable target only on plain anvil, so verify that there too.
  const escrowBefore = await balanceOf(ESCROW)
  const walletBefore = await balanceOf(settlement.winner)
  const receipt = await send(who, 'withdraw')

  const leftEscrow = escrowBefore - (await balanceOf(ESCROW))
  if (leftEscrow !== owed) throw new Error(`${leftEscrow} left escrow, owed ${owed}`)
  if ((await read('balances', [settlement.winner])) !== 0n) throw new Error('balance not cleared')

  if (!FORK) {
    const gas = receipt.gasUsed * receipt.effectiveGasPrice
    const gained = (await balanceOf(settlement.winner)) - walletBefore + gas
    if (gained !== owed) throw new Error(`wallet received ${gained}, owed ${owed}`)
  }
})

await step('the server reconciles to settled once the chain says so', async () => {
  // The winner settles from their own wallet, so the server only learns by
  // looking. The reconciler runs on a 30s timer; poll for it.
  const deadline = Date.now() + 60_000
  for (;;) {
    const winnerIsAlice = winnerAddr.toLowerCase() === alice.address.toLowerCase()
    const who = winnerIsAlice ? alice : bob
    const { body } = await api('/api/me/unclaimed', { headers: auth(who.token) })
    if (Array.isArray(body) && body.length === 0) return
    if (Date.now() > deadline) {
      throw new Error(`still shows as unclaimed after settling: ${JSON.stringify(body)}`)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
})

await step('health recovers once the pot is collected', async () => {
  const deadline = Date.now() + 60_000
  for (;;) {
    const r = await api('/api/health')
    if (r.status === 200 && r.body?.ok) return
    if (Date.now() > deadline) {
      const bad = (r.body?.checks ?? []).filter((c) => !c.ok)
      throw new Error(`health still failing: ${JSON.stringify(bad)}`)
    }
    await new Promise((res) => setTimeout(res, 2000))
  }
})

await mustRevert(
  'the same wager cannot be settled twice',
  () => send('alice', 'settle', [onchainId, settlement.winner, settlement.signature]),
  'WagerNotActive',
)

await mustRevert(
  'withdrawing an empty balance reverts',
  () => send('alice', 'withdraw'),
  'NothingToWithdraw',
)

/* ------------------------------------------------------------------ */
/* B. rejected signatures                                              */
/* ------------------------------------------------------------------ */

console.log('\n— B. signatures that must be rejected —')

await step('a signature from the wrong key is refused', async () => {
  const expiry2 = await soon()
  await send('alice', 'createWager', [STAKE, expiry2], STAKE)
  const id = await read('wagerCount')
  await send('bob', 'acceptWager', [id], STAKE)

  // Sign the right struct with a key the contract does not trust.
  const nonce = (await read('getWager', [id])).nonce
  const bogus = await wallet('bob').signTypedData({
    domain: {
      name: 'PokePlayEscrow',
      version: '1',
      chainId: await pub.getChainId(),
      verifyingContract: ESCROW,
    },
    types: {
      BattleResult: [
        { name: 'wagerId', type: 'uint256' },
        { name: 'winner', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'BattleResult',
    message: { wagerId: id, winner: account('bob').address, nonce },
  })

  let threw = null
  try {
    await send('bob', 'settle', [id, account('bob').address, bogus])
  } catch (e) {
    threw = e
  }
  if (!threw) throw new Error('the contract accepted a forged signature')
  if (!threw.message.includes('InvalidArbiterSignature')) {
    throw new Error(`wrong revert: ${threw.message.split('\n')[0]}`)
  }
  return id
})

/* ------------------------------------------------------------------ */
/* C. timeout refund — the users' only protection                      */
/* ------------------------------------------------------------------ */

console.log('\n— C. timeout refund, with the server uninvolved —')

await step('claimTimeout refunds both stakes and takes no fee', async () => {
  const expiry3 = await soon()
  const aliceBefore = await read('balances', [account('alice').address])
  const bobBefore = await read('balances', [account('bob').address])
  await send('alice', 'createWager', [STAKE, expiry3], STAKE)
  const id = await read('wagerCount')
  await send('bob', 'acceptWager', [id], STAKE)

  const timeout = await read('settleTimeout')

  await mustRevert(
    'claiming before the timeout reverts',
    () => send('alice', 'claimTimeout', [id]),
    'TimeoutNotReached',
  )

  // Jump past the timeout. anvil lets us do in a second what mainnet needs a
  // day for; this is the whole reason to run locally first.
  await fetch(process.env.RPC_URL ?? 'http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'evm_increaseTime', params: [Number(timeout) + 60],
    }),
  })
  await fetch(process.env.RPC_URL ?? 'http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }),
  })

  await send('alice', 'claimTimeout', [id])

  const a = (await read('balances', [account('alice').address])) - aliceBefore
  const b = (await read('balances', [account('bob').address])) - bobBefore
  if (a !== STAKE) throw new Error(`alice refunded ${a}, expected ${STAKE}`)
  if (b !== STAKE) throw new Error(`bob refunded ${b}, expected ${STAKE}`)
  const w = await read('getWager', [id])
  if (Number(w.status) !== STATUS.REFUNDED) {
    throw new Error(`status ${w.status}, expected REFUNDED`)
  }
})

/* ------------------------------------------------------------------ */
/* D. owner powers                                                     */
/* ------------------------------------------------------------------ */

console.log('\n— D. owner powers —')

await step('pause blocks new wagers, unpause restores them', async () => {
  await ownerSend('pause')
  let threw = null
  try {
    await send('alice', 'createWager', [STAKE, await soon()], STAKE)
  } catch (e) {
    threw = e
  }
  if (!threw) throw new Error('a wager was created while paused')
  await ownerSend('unpause')
  await send('alice', 'createWager', [STAKE, await soon()], STAKE)
})

await step('rotating the arbiter invalidates the old key', async () => {
  const before = await read('arbiter')
  await ownerSend('setArbiter', [account('treasury').address])
  const now = await read('arbiter')
  if (now.toLowerCase() !== account('treasury').address.toLowerCase()) {
    throw new Error('setArbiter did not take')
  }
  // Put it back so the server stays consistent for anything after this.
  await ownerSend('setArbiter', [before])
})

/* ------------------------------------------------------------------ */

const ok = summary('dry run')
process.exit(ok ? 0 : 1)
