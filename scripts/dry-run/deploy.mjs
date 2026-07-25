/**
 * Deploys PokePlayEscrow to the local anvil node and prints the address.
 *
 * Separate from the flow script because the server needs ESCROW_ADDRESS in its
 * environment at boot, so the deploy has to happen first.
 */
import { artifact, account, pub, wallet } from './lib.mjs'

const FEE_BPS = Number(process.env.FEE_BPS ?? 250)

const { abi, bytecode } = artifact()
const deployer = wallet('deployer')

const hash = await deployer.deployContract({
  abi,
  bytecode,
  args: [
    account('deployer').address,
    account('arbiter').address,
    account('treasury').address,
    FEE_BPS,
  ],
})

const receipt = await pub.waitForTransactionReceipt({ hash })
if (!receipt.contractAddress) throw new Error('deploy produced no contract address')

const [domainSep, timeout] = await Promise.all([
  pub.readContract({ address: receipt.contractAddress, abi, functionName: 'domainSeparator' }),
  pub.readContract({ address: receipt.contractAddress, abi, functionName: 'settleTimeout' }),
])

console.error(`  owner    ${account('deployer').address}`)
console.error(`  arbiter  ${account('arbiter').address}`)
console.error(`  treasury ${account('treasury').address}`)
console.error(`  feeBps   ${FEE_BPS}`)
console.error(`  timeout  ${timeout}s`)
console.error(`  domain   ${domainSep}`)
console.error(`  gas used ${receipt.gasUsed}`)

// stdout carries only the address, so the shell can capture it.
process.stdout.write(receipt.contractAddress)
