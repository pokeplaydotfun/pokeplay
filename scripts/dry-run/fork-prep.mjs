/**
 * Prepares a forked-mainnet anvil so the dry run can drive the REAL deployed
 * escrow instead of a fresh copy of it.
 *
 * What a fork buys over `npm run dry-run`: the bytecode, the constructor args,
 * the accrued state and the chain id are the live ones. A bug that only exists
 * in what was actually deployed — a wrong treasury, a fee nobody re-checked, a
 * domain separator that disagrees with what the server signs — shows up here
 * and cannot show up against a fresh deploy.
 *
 * Nothing here can touch mainnet: every write goes to the local fork, which is
 * thrown away when anvil exits.
 */
import { createWalletClient, http } from 'viem'
import { account, local, pub, artifact, RPC } from './lib.mjs'

const ESCROW = process.env.ESCROW_ADDRESS
if (!ESCROW) throw new Error('ESCROW_ADDRESS is required')

const { abi } = artifact()
const at = { address: ESCROW, abi }
const read = (functionName, args = []) => pub.readContract({ ...at, functionName, args })

const rpc = async (method, params = []) => {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await res.json()
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

/* -- 1. what is actually deployed -------------------------------------- */

const code = await pub.getBytecode({ address: ESCROW })
if (!code || code === '0x') {
  throw new Error(`no contract at ${ESCROW} on the forked chain — wrong address or wrong fork`)
}

const [owner, arbiter, treasury, feeBps, timeout, domain, count, held, chainId] = await Promise.all([
  read('owner'),
  read('arbiter'),
  read('treasury'),
  read('feeBps'),
  read('settleTimeout'),
  read('domainSeparator'),
  read('wagerCount'),
  pub.getBalance({ address: ESCROW }),
  pub.getChainId(),
])

console.error(`  chain id   ${chainId}`)
console.error(`  bytecode   ${(code.length - 2) / 2} bytes`)
console.error(`  owner      ${owner}`)
console.error(`  arbiter    ${arbiter}  (live)`)
console.error(`  treasury   ${treasury}`)
console.error(`  feeBps     ${feeBps}`)
console.error(`  timeout    ${timeout}s`)
console.error(`  domain     ${domain}`)
console.error(`  wagers     ${count} so far, contract holds ${held} wei`)

/* -- 2. sanity-check it against the documented config ------------------- */

const expect = (label, got, want) => {
  if (want && got.toLowerCase() !== want.toLowerCase()) {
    throw new Error(`${label} is ${got} on chain, but DEPLOY-CONFIG says ${want}`)
  }
}
expect('owner', owner, process.env.EXPECT_OWNER)
expect('treasury', treasury, process.env.EXPECT_TREASURY)
expect('arbiter', arbiter, process.env.EXPECT_ARBITER)
if (process.env.EXPECT_FEE_BPS && String(feeBps) !== process.env.EXPECT_FEE_BPS) {
  throw new Error(`feeBps is ${feeBps} on chain, expected ${process.env.EXPECT_FEE_BPS}`)
}
console.error('  ✓ live config matches DEPLOY-CONFIG.md')

/* -- 3. make the fork drivable ----------------------------------------- */

// Test wallets need gas and stake money. This is fork-local funny money.
const FUND = '0x21e19e0c9bab2400000' // 10_000 ETH
for (const name of ['alice', 'bob', 'deployer']) {
  await rpc('anvil_setBalance', [account(name).address, FUND])
}
await rpc('anvil_setBalance', [owner, FUND])

// The live arbiter's key is on the server, not here, so the fork's arbiter is
// repointed at a key we do hold. This is the one deliberate divergence from
// mainnet, and it only exists inside the fork.
const ownerClient = createWalletClient({ account: owner, chain: local, transport: http(RPC) })
const hash = await ownerClient.writeContract({
  ...at,
  functionName: 'setArbiter',
  args: [account('arbiter').address],
})
await pub.waitForTransactionReceipt({ hash })

const now = await read('arbiter')
if (now.toLowerCase() !== account('arbiter').address.toLowerCase()) {
  throw new Error('setArbiter did not take on the fork')
}
console.error(`  arbiter    ${now}  (fork-local, so the local server can sign)`)

// stdout carries only the treasury, so the shell can capture it.
process.stdout.write(treasury)
