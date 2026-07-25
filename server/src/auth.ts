import { randomBytes } from 'node:crypto'
import { verifyMessage, isAddress, getAddress } from 'viem'
import { db, now, ensureUser } from './db.js'

const NONCE_TTL = 5 * 60 // seconds
const SESSION_TTL = 7 * 24 * 60 * 60

export const normalise = (a: string) => a.toLowerCase()

/**
 * Wallet login: the server issues a single-use nonce, the wallet signs it, and
 * we recover the address. Signing proves control of the key without exposing
 * it, and the nonce stops a captured signature being replayed.
 */
export function issueNonce(address: string): string {
  if (!isAddress(address)) throw new Error('invalid address')
  const nonce = randomBytes(16).toString('hex')
  db.prepare('INSERT INTO nonces (nonce, address, issued_at) VALUES (?, ?, ?)').run(
    nonce,
    normalise(address),
    now(),
  )
  return nonce
}

export function loginMessage(nonce: string, address: string): string {
  return [
    'Sign in to PokePlay.',
    '',
    `Address: ${getAddress(address)}`,
    `Nonce: ${nonce}`,
    '',
    'This signature proves you own this wallet. It does not authorise any transaction.',
  ].join('\n')
}

/**
 * The message a player signs to claim their username.
 *
 * States plainly that the choice is permanent, because it is — there is no
 * rename endpoint, by design.
 */
export function usernameMessage(nonce: string, address: string, name: string): string {
  return [
    'Claim your PokePlay username.',
    '',
    `Username: ${name}`,
    `Address: ${getAddress(address)}`,
    `Nonce: ${nonce}`,
    '',
    'This name is permanent and cannot be changed later.',
    'This signature proves you own this wallet. It does not authorise any transaction.',
  ].join('\n')
}

/** Verifies a username claim signature and burns the nonce. Throws on failure. */
export async function verifyUsernameClaim(
  address: string,
  name: string,
  nonce: string,
  signature: `0x${string}`,
): Promise<void> {
  if (!isAddress(address)) throw new Error('invalid address')
  const addr = normalise(address)

  const row = db.prepare('SELECT * FROM nonces WHERE nonce = ?').get(nonce) as
    | { address: string; issued_at: number; used: number }
    | undefined

  if (!row) throw new Error('unknown nonce')
  if (row.used) throw new Error('nonce already used')
  if (row.address !== addr) throw new Error('nonce was issued to a different address')
  if (now() - row.issued_at > NONCE_TTL) throw new Error('nonce expired')

  const ok = await verifyMessage({
    address: getAddress(address),
    message: usernameMessage(nonce, address, name),
    signature,
  })
  if (!ok) throw new Error('bad signature')

  db.prepare('UPDATE nonces SET used = 1 WHERE nonce = ?').run(nonce)
}

export async function verifyLogin(
  address: string,
  nonce: string,
  signature: `0x${string}`,
): Promise<string> {
  if (!isAddress(address)) throw new Error('invalid address')
  const addr = normalise(address)

  const row = db.prepare('SELECT * FROM nonces WHERE nonce = ?').get(nonce) as
    | { address: string; issued_at: number; used: number }
    | undefined

  if (!row) throw new Error('unknown nonce')
  if (row.used) throw new Error('nonce already used')
  if (row.address !== addr) throw new Error('nonce was issued to a different address')
  if (now() - row.issued_at > NONCE_TTL) throw new Error('nonce expired')

  const ok = await verifyMessage({
    address: getAddress(address),
    message: loginMessage(nonce, address),
    signature,
  })
  if (!ok) throw new Error('bad signature')

  // Burn the nonce before issuing the session.
  db.prepare('UPDATE nonces SET used = 1 WHERE nonce = ?').run(nonce)
  ensureUser(addr)

  const token = randomBytes(32).toString('hex')
  db.prepare(
    'INSERT INTO sessions (token, address, issued_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(token, addr, now(), now() + SESSION_TTL)

  return token
}

/**
 * Local-only login that skips the wallet signature, so one person can drive two
 * browser windows and play themselves.
 *
 * Deliberately gated three ways: an explicit opt-in env var, a hard refusal
 * when NODE_ENV is production, and a fixed set of throwaway addresses. This is
 * an authentication bypass — if any of those guards is ever relaxed, anyone can
 * log in as anyone.
 */
export const devLoginEnabled =
  process.env.DEV_LOGIN === '1' && process.env.NODE_ENV !== 'production'

/** Fixed test accounts. Well-known keys — never fund these on a real network. */
export const DEV_ACCOUNTS: Record<string, string> = {
  ash: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  gary: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  brock: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  misty: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
}

export function devLogin(who: string): { token: string; address: string } {
  if (!devLoginEnabled) throw new Error('dev login is disabled')
  const address = DEV_ACCOUNTS[who.toLowerCase()]
  if (!address) throw new Error(`unknown dev account "${who}"`)

  ensureUser(address)
  db.prepare('UPDATE users SET name = COALESCE(name, ?) WHERE address = ?').run(
    who.charAt(0).toUpperCase() + who.slice(1),
    address,
  )

  const token = randomBytes(32).toString('hex')
  db.prepare(
    'INSERT INTO sessions (token, address, issued_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(token, address, now(), now() + SESSION_TTL)

  return { token, address }
}

/** Returns the address for a session token, or null. */
export function sessionAddress(token: string | undefined): string | null {
  if (!token) return null
  const row = db.prepare('SELECT address, expires_at FROM sessions WHERE token = ?').get(token) as
    | { address: string; expires_at: number }
    | undefined
  if (!row || row.expires_at < now()) return null
  return row.address
}

export function logout(token: string) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

/** Periodic cleanup so the tables do not grow without bound. */
export function pruneAuth() {
  db.prepare('DELETE FROM nonces WHERE issued_at < ?').run(now() - NONCE_TTL * 2)
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now())
}
