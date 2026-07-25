/**
 * Regression: an arbiter key that is PRESENT but has no 0x prefix, with escrow
 * not yet deployed, must not crash the server at import time. This exact state
 * crash-looped the live service — settle.ts built the account from the raw key
 * unconditionally, and viem threw on the missing prefix, taking the whole site
 * (including free play) down.
 */
import assert from 'node:assert'

// The failing shape: valid 32-byte key, no 0x, no escrow.
process.env.ARBITER_PRIVATE_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
delete process.env.ESCROW_ADDRESS

const m = await import('./settle.js')

assert.ok(m.arbiterAddress, 'a 0x-less key should still derive an arbiter address')
assert.strictEqual(m.settlementEnabled, false, 'no escrow means settlement must be off')

console.log('1 settle regression check passed')
