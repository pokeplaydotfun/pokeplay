/**
 * Anvil's deterministic test accounts, DERIVED rather than hard-coded.
 *
 * These are the accounts Anvil prints in its own startup banner: worthless,
 * public, funded only on a throwaway local node, and identical in every Foundry
 * project. We derive them from Anvil's standard mnemonic so the repository never
 * contains a literal `0x…`-64-hex private key — which reads as a leaked secret
 * and trips secret scanners even when it is nothing of the sort.
 *
 * NEVER put a real key here. Real keys live only in the server's .env on the box.
 */
import { mnemonicToAccount } from 'viem/accounts'
import { toHex } from 'viem'
import { pathToFileURL } from 'node:url'

/** Anvil's published test mnemonic. Public and standard — not a secret. */
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'

/** The 0x private key of Anvil account `index` (0-based, as Anvil lists them). */
export function anvilKey(index) {
  return toHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey().privateKey)
}

// CLI: `node anvil.mjs <index>` prints one key, for shell scripts that must pass
// it to the server as an env var without hard-coding it.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(anvilKey(Number(process.argv[2] ?? 0)))
}
