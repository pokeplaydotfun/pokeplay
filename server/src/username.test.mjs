/**
 * Usernames: claimed once, signed by the wallet, unique, permanent.
 *
 * Runs against a live server so the signatures are real secp256k1 signatures
 * over the real message, not a stub. Uniqueness is checked under a genuine
 * race, because a check-then-write handler passes every sequential test and
 * still lets two people take the same name.
 */
import assert from 'node:assert'
import { privateKeyToAccount } from 'viem/accounts'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8094'

let passed = 0
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`✓ ${name}`) } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`)
    process.exitCode = 1
  }
}

const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const auth = (t) => ({ authorization: `Bearer ${t}` })

async function signIn(i) {
  const account = privateKeyToAccount('0x' + (i + 1).toString(16).padStart(64, '0'))
  const { body: n } = await api('/api/auth/nonce', {
    method: 'POST', body: JSON.stringify({ address: account.address }),
  })
  const signature = await account.signMessage({ message: n.message })
  const { body: v } = await api('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ address: account.address, nonce: n.nonce, signature }),
  })
  assert.ok(v?.token, `login failed: ${JSON.stringify(v)}`)
  return { account, token: v.token, address: account.address.toLowerCase() }
}

/** The full claim flow: ask for a message, sign it, submit it. */
async function claim(who, name, { tamper } = {}) {
  const { status, body } = await api('/api/username/nonce', {
    method: 'POST', headers: auth(who.token), body: JSON.stringify({ name }),
  })
  if (status !== 200) return { status, body }
  const signature = await who.account.signMessage({ message: body.message })
  return api('/api/username', {
    method: 'POST',
    headers: auth(who.token),
    body: JSON.stringify({ name: tamper ?? name, nonce: body.nonce, signature }),
  })
}

let seq = 100
const nextUser = () => signIn(seq++)

/* ------------------------------------------------------------------ */

await check('a new wallet is told it needs a username', async () => {
  const u = await nextUser()
  const { body } = await api('/api/me', { headers: auth(u.token) })
  assert.strictEqual(body.name, null, `name was ${body.name}`)
  assert.strictEqual(body.needsUsername, true)
})

await check('a valid name can be claimed with a wallet signature', async () => {
  const u = await nextUser()
  const r = await claim(u, 'ashketchum')
  assert.strictEqual(r.status, 200, JSON.stringify(r.body))
  const { body } = await api('/api/me', { headers: auth(u.token) })
  assert.strictEqual(body.name, 'ashketchum')
  assert.strictEqual(body.needsUsername, false)
})

await check('the same name cannot be taken twice, in any case', async () => {
  const u = await nextUser()
  const r = await claim(u, 'AshKetchum')
  assert.strictEqual(r.status, 409, `expected 409, got ${r.status} ${JSON.stringify(r.body)}`)
})

await check('a username cannot be changed once claimed', async () => {
  const u = await nextUser()
  assert.strictEqual((await claim(u, 'brockrocks')).status, 200)
  const second = await claim(u, 'brocknew')
  assert.strictEqual(second.status, 409, `rename allowed: ${JSON.stringify(second.body)}`)
  const { body } = await api('/api/me', { headers: auth(u.token) })
  assert.strictEqual(body.name, 'brockrocks', 'the name changed')
})

await check('a signature over a different name is rejected', async () => {
  const u = await nextUser()
  // Ask to sign for one name, then submit another.
  const r = await claim(u, 'mistywater', { tamper: 'somethingelse' })
  assert.ok(r.status === 401 || r.status === 400, `expected rejection, got ${r.status}`)
  const { body } = await api('/api/me', { headers: auth(u.token) })
  assert.strictEqual(body.name, null, `a tampered claim set the name to ${body.name}`)
})

await check("another wallet's signature cannot claim your name", async () => {
  const victim = await nextUser()
  const attacker = await nextUser()
  const { body } = await api('/api/username/nonce', {
    method: 'POST', headers: auth(victim.token), body: JSON.stringify({ name: 'stolenname' }),
  })
  // The attacker signs the victim's message and submits it on their own session.
  const signature = await attacker.account.signMessage({ message: body.message })
  const r = await api('/api/username', {
    method: 'POST',
    headers: auth(attacker.token),
    body: JSON.stringify({ name: 'stolenname', nonce: body.nonce, signature }),
  })
  assert.strictEqual(r.status, 401, `expected 401, got ${r.status} ${JSON.stringify(r.body)}`)
})

await check('a nonce cannot be replayed', async () => {
  const u = await nextUser()
  const { body } = await api('/api/username/nonce', {
    method: 'POST', headers: auth(u.token), body: JSON.stringify({ name: 'replayer' }),
  })
  const signature = await u.account.signMessage({ message: body.message })
  const first = await api('/api/username', {
    method: 'POST', headers: auth(u.token),
    body: JSON.stringify({ name: 'replayer', nonce: body.nonce, signature }),
  })
  assert.strictEqual(first.status, 200)

  const other = await nextUser()
  const replayed = await api('/api/username', {
    method: 'POST', headers: auth(other.token),
    body: JSON.stringify({ name: 'replayer', nonce: body.nonce, signature }),
  })
  assert.ok(replayed.status >= 400, 'a used nonce was accepted again')
})

await check('bad names are refused', async () => {
  const cases = [
    ['ab', 'too short'],
    ['a'.repeat(17), 'too long'],
    ['has space', 'space'],
    ['emoji🙂', 'non-ascii'],
    ['_leading', 'leading underscore'],
    ['trailing_', 'trailing underscore'],
    ['0xdeadbeef', 'looks like an address'],
    ['admin', 'reserved'],
    ['PokePlay', 'reserved, different case'],
    ['dots.here', 'dots'],
  ]
  for (const [name, why] of cases) {
    const u = await nextUser()
    const r = await claim(u, name)
    assert.ok(r.status >= 400, `accepted ${JSON.stringify(name)} (${why})`)
  }
})

await check('availability check agrees with what claiming does', async () => {
  const u = await nextUser()
  const free = await api(`/api/username/check?name=freshname99`, { headers: auth(u.token) })
  assert.strictEqual(free.body.available, true, JSON.stringify(free.body))

  const taken = await api(`/api/username/check?name=ashketchum`, { headers: auth(u.token) })
  assert.strictEqual(taken.body.available, false)

  const bad = await api(`/api/username/check?name=ad`, { headers: auth(u.token) })
  assert.strictEqual(bad.body.available, false)
})

await check('two wallets racing for one name: exactly one wins', async () => {
  // The real test. A check-then-write handler passes everything above and
  // still lets both of these through.
  const racers = await Promise.all([nextUser(), nextUser(), nextUser(), nextUser()])
  const results = await Promise.all(racers.map((r) => claim(r, 'contested')))
  const winners = results.filter((r) => r.status === 200)
  assert.strictEqual(
    winners.length, 1,
    `${winners.length} wallets claimed the same name: ${JSON.stringify(results.map((r) => r.status))}`,
  )

  const named = await Promise.all(
    racers.map(async (r) => (await api('/api/me', { headers: auth(r.token) })).body.name),
  )
  assert.strictEqual(
    named.filter((n) => n === 'contested').length, 1,
    `the database holds the name more than once: ${JSON.stringify(named)}`,
  )
})

console.log(`\n${passed} username checks passed${process.exitCode ? ' (with failures)' : ''}`)
process.exit(process.exitCode ?? 0)
