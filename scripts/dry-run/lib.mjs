/**
 * Shared plumbing for the local dry run.
 *
 * Everything here talks to a local anvil node using Foundry's published test
 * accounts. Those keys are in anvil's own startup banner and are worthless —
 * they exist so nobody has to invent a key to test with. Never point this at a
 * real chain, and never put a real key in here.
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, defineChain, http, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import WebSocket from 'ws'
import { anvilKey } from './anvil.mjs'

export const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545'
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337)
export const BASE = process.env.BASE ?? 'http://127.0.0.1:8098'

export const local = defineChain({
  id: CHAIN_ID,
  name: 'anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})

/**
 * anvil's deterministic accounts, in the order it prints them (0-9). Derived
 * from anvil's mnemonic rather than hard-coded, so no literal private key lives
 * in the repo — see anvil.mjs. The last two pay real entry fees in the browser
 * pass, so no other step may spend from them (the assertions are balance deltas).
 */
const KEY_ORDER = [
  'deployer', 'arbiter', 'alice', 'bob', 'treasury',
  'bob2', 'carol', 'quickstart', 'entrant1', 'entrant2',
]
export const KEYS = Object.fromEntries(KEY_ORDER.map((name, i) => [name, anvilKey(i)]))

export const account = (name) => privateKeyToAccount(KEYS[name])

export const pub = createPublicClient({ chain: local, transport: http(RPC) })

export const wallet = (name) =>
  createWalletClient({ account: account(name), chain: local, transport: http(RPC) })

/**
 * Whoever holds owner powers on the escrow under test.
 *
 * On a fresh anvil deploy that is the deploy key, and we have it. On a fork of
 * mainnet the owner is a real wallet whose key we deliberately do not have, so
 * anvil impersonates it instead (`--auto-impersonate`). Set IMPERSONATE_OWNER
 * to that address to switch modes.
 */
export const IMPERSONATED_OWNER = process.env.IMPERSONATE_OWNER ?? null

export const ownerWallet = () =>
  IMPERSONATED_OWNER
    ? createWalletClient({ account: IMPERSONATED_OWNER, chain: local, transport: http(RPC) })
    : wallet('deployer')

/** The address fees accrue to — a real wallet when running against a fork. */
export const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS ?? account('treasury').address

/**
 * Are we running against a fork of a live chain, rather than a clean anvil?
 *
 * Robinhood Chain is an L2 whose fee is an L1-data component anvil does not
 * model correctly on a fork: a single transaction drains almost the whole
 * sender balance while the receipt reports a few thousand wei of gas. That
 * makes wallet-balance deltas meaningless and starves later transactions. In
 * fork mode we top senders up before each tx and assert exact amounts against
 * the escrow's own balance and internal ledger instead of anyone's wallet.
 */
export const FORK = process.env.FORK === '1'

const TOPUP = '0x3635c9adc5dea00000' // 1000 ETH, as an anvil_setBalance quantity

/** Give an address plenty of balance on the fork so its next tx can pay. */
export async function topUp(address) {
  if (!FORK) return
  await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [address, TOPUP] }),
  })
}

const artifactPath = new URL(
  '../../contracts/out/PokePlayEscrow.sol/PokePlayEscrow.json',
  import.meta.url,
)

export function artifact() {
  const a = JSON.parse(readFileSync(artifactPath, 'utf8'))
  return { abi: a.abi, bytecode: a.bytecode.object }
}

/* ------------------------------------------------------------------ */
/* result tracking                                                     */
/* ------------------------------------------------------------------ */

const results = []

export async function step(name, fn) {
  const started = Date.now()
  try {
    const out = await fn()
    results.push({ name, ok: true, ms: Date.now() - started })
    console.log(`  ✓ ${name}`)
    return out
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - started, err: e.message })
    console.error(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`)
    process.exitCode = 1
    return null
  }
}

/** Asserts the call reverts. Used for the "must not be allowed" cases. */
export async function mustRevert(name, fn, expect) {
  await step(name, async () => {
    let threw = null
    try {
      await fn()
    } catch (e) {
      threw = e
    }
    if (!threw) throw new Error('expected a revert, but the call succeeded')
    if (expect && !threw.message.includes(expect)) {
      throw new Error(`reverted, but not with "${expect}": ${threw.message.split('\n')[0]}`)
    }
  })
}

export function summary(title) {
  const ok = results.filter((r) => r.ok).length
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${title}: ${ok}/${results.length} passed`)
  for (const r of bad) console.log(`  ✗ ${r.name} — ${r.err.split('\n')[0]}`)
  return bad.length === 0
}

/* ------------------------------------------------------------------ */
/* server API                                                          */
/* ------------------------------------------------------------------ */

export const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

export const auth = (token) => ({ authorization: `Bearer ${token}` })

export async function login(name) {
  const acct = account(name)
  const { body: n } = await api('/api/auth/nonce', {
    method: 'POST',
    body: JSON.stringify({ address: acct.address }),
  })
  const signature = await acct.signMessage({ message: n.message })
  const { body: v } = await api('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ address: acct.address, nonce: n.nonce, signature }),
  })
  if (!v?.token) throw new Error(`login failed for ${name}: ${JSON.stringify(v)}`)
  return { token: v.token, address: acct.address, name }
}

/* ------------------------------------------------------------------ */
/* battle socket                                                       */
/* ------------------------------------------------------------------ */

export function connect(token) {
  const sock = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${token}`)
  const queue = []
  const waiters = []

  sock.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    const w = waiters.shift()
    if (w) w(m)
    else queue.push(m)
  })

  const next = () =>
    queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))

  return {
    sock,
    next,
    send: (m) => sock.send(JSON.stringify(m)),
    close: () => sock.close(),
    open: new Promise((r, j) => {
      sock.on('open', () => r())
      sock.on('error', j)
    }),
    async until(type, limit = 600) {
      for (let i = 0; i < limit; i++) {
        const m = await next()
        if (m.type === type) return m
      }
      throw new Error(`never received "${type}"`)
    },
  }
}

/**
 * Plays a battle to its end by always using move 0, replacing fainted Pokémon
 * as required. Returns the `ended` message.
 */
export async function playOut(a, b, { onEnd } = {}) {
  const seats = [a, b]
  for (const s of seats) await s.open
  const ended = { value: null }

  const drive = async (s) => {
    for (let i = 0; i < 800 && !ended.value; i++) {
      const m = await s.next()
      if (m.type === 'ended') {
        ended.value = m
        onEnd?.(m)
        return
      }
      if (m.type !== 'state') continue
      if (m.state?.finished) continue
      if (m.state?.mustReplace) {
        // A forced replacement rides the same 'action' message as everything else.
        const idx = m.state.you.team.findIndex((x) => !x.fainted)
        if (idx >= 0) s.send({ type: 'action', action: { kind: 'switch', index: idx } })
        continue
      }
      // Must pick a move that still has PP. The engine only falls back to
      // Struggle when EVERY move is spent, so hardcoding move 0 deadlocks the
      // match the moment move 0 runs dry.
      const active = m.state.you.team[m.state.you.active]
      const withPp = active?.moves.findIndex((mv) => mv.pp > 0) ?? -1
      s.send({ type: 'action', action: { kind: 'move', index: withPp >= 0 ? withPp : 0 } })
    }
  }

  await Promise.race([
    Promise.all(seats.map(drive)),
    new Promise((_, j) => setTimeout(() => j(new Error('battle timed out')), 120_000)),
  ])
  if (!ended.value) throw new Error('battle never produced an ended message')
  return ended.value
}

export const TEAM_NAMES = ['pikachu', 'charizard', 'blastoise', 'venusaur', 'alakazam', 'snorlax']

export const eth = parseEther
