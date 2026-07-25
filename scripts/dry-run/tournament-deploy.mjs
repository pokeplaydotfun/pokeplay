/**
 * Deploys PokePlayTournamentPool to the local node (plain anvil or a fork) and
 * prints the address. Separate from the flow so the address can be captured by
 * the shell before the scenarios run.
 */
import { readFileSync } from 'node:fs'
import { account, pub, wallet } from './lib.mjs'

const FEE_BPS = Number(process.env.FEE_BPS ?? 250)

const artifactPath = new URL(
  '../../contracts/out/PokePlayTournamentPool.sol/PokePlayTournamentPool.json',
  import.meta.url,
)
const a = JSON.parse(readFileSync(artifactPath, 'utf8'))

const deployer = wallet('deployer')

const hash = await deployer.deployContract({
  abi: a.abi,
  bytecode: a.bytecode.object,
  args: [
    account('deployer').address, // owner
    account('arbiter').address, // arbiter
    account('treasury').address, // treasury
    FEE_BPS,
  ],
})

const receipt = await pub.waitForTransactionReceipt({ hash })
if (!receipt.contractAddress) throw new Error('deploy produced no contract address')

const [domainSep, timeout] = await Promise.all([
  pub.readContract({ address: receipt.contractAddress, abi: a.abi, functionName: 'domainSeparator' }),
  pub.readContract({ address: receipt.contractAddress, abi: a.abi, functionName: 'settleTimeout' }),
])

console.error(`  owner    ${account('deployer').address}`)
console.error(`  arbiter  ${account('arbiter').address}`)
console.error(`  treasury ${account('treasury').address}`)
console.error(`  feeBps   ${FEE_BPS}`)
console.error(`  timeout  ${timeout}s`)
console.error(`  domain   ${domainSep}`)
console.error(`  gas used ${receipt.gasUsed}`)

process.stdout.write(receipt.contractAddress)
