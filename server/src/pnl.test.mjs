/**
 * Realised profit and loss.
 *
 * The arithmetic must match what the escrow actually pays: the winner gets the
 * pot minus the fee, so their profit is one stake minus the fee, and the loser
 * is down exactly one stake. Anything else means the leaderboard is telling
 * people they made money they did not.
 */
import assert from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

process.env.DB_PATH = `/tmp/pp-pnl-${randomUUID()}.db`
const { db } = await import('./db.js')

let passed = 0
const check = (n, f) => {
  try { f(); passed++; console.log(`✓ ${n}`) } catch (e) {
    console.error(`✗ ${n}\n  ${e.message}`); process.exitCode = 1
  }
}

const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)
for (const a of [A, B]) {
  db.prepare('INSERT OR IGNORE INTO users (address,name,wins,losses,draws,created_at) VALUES (?,NULL,0,0,0,0)').run(a)
}
// wagers references teams(id); without real rows every insert trips the
// foreign key rather than testing the arithmetic.
db.prepare('INSERT INTO teams (id,address,name,slots,created_at,updated_at) VALUES (1,?,?,?,0,0)')
  .run(A, 'a', '[]')
db.prepare('INSERT INTO teams (id,address,name,slots,created_at,updated_at) VALUES (2,?,?,?,0,0)')
  .run(B, 'b', '[]')

/** Mirrors realisedPnl() in index.ts. */
function pnl() {
  const rows = db.prepare(`
    SELECT w.stake_wei, w.fee_bps, b.winner, b.p0, b.p1
    FROM wagers w JOIN battles b ON b.id = w.battle_id
    WHERE w.status = 'settled' AND w.onchain_id IS NOT NULL
      AND w.stake_wei != '0' AND b.winner IS NOT NULL
  `).all()
  const net = new Map()
  const add = (a, d) => net.set(a, (net.get(a) ?? 0n) + d)
  for (const r of rows) {
    const stake = BigInt(r.stake_wei)
    if (stake <= 0n) continue
    const winner = r.winner === 0 ? r.p0 : r.p1
    const loser = r.winner === 0 ? r.p1 : r.p0
    const fee = (stake * 2n * BigInt(r.fee_bps ?? 0)) / 10000n
    add(winner, stake - fee)
    add(loser, -stake)
  }
  return net
}

let seq = 0
function settled({ stake, feeBps, winnerSide, status = 'settled', onchain = '1' }) {
  const bid = randomUUID()
  db.prepare(`INSERT INTO battles (id,wager_id,p0,p1,seed,seed_hash,started_at,winner,ended_at)
              VALUES (?,NULL,?,?,'s','h',0,?,1)`).run(bid, A, B, winnerSide)
  db.prepare(`INSERT INTO wagers (id,onchain_id,creator,creator_team,opponent,opponent_team,
              stake_wei,status,battle_id,created_at,expires_at,fee_bps)
              VALUES (?,?,?,1,?,2,?,?,?,0,0,?)`)
    .run(++seq, onchain, A, B, stake, status, bid, feeBps)
}

const ETH = 10n ** 18n

check('winner gains a stake minus the fee; loser is down a stake', () => {
  settled({ stake: (ETH / 100n).toString(), feeBps: 250, winnerSide: 0 })
  const p = pnl()
  // 0.01 staked each. Pot 0.02, fee 2.5% = 0.0005. Winner nets +0.0095.
  assert.strictEqual(p.get(A), ETH / 100n - (ETH / 100n * 2n * 250n) / 10000n)
  assert.strictEqual(p.get(A), 9500000000000000n, `winner got ${p.get(A)}`)
  assert.strictEqual(p.get(B), -(ETH / 100n), `loser got ${p.get(B)}`)
})

check('the pair nets out to exactly the fee the house took', () => {
  const p = pnl()
  const total = p.get(A) + p.get(B)
  assert.strictEqual(total, -500000000000000n, `players netted ${total}, expected -fee`)
})

check('a zero fee makes it a clean transfer', () => {
  db.exec('DELETE FROM wagers; DELETE FROM battles')
  seq = 0
  settled({ stake: ETH.toString(), feeBps: 0, winnerSide: 1 })
  const p = pnl()
  assert.strictEqual(p.get(B), ETH)
  assert.strictEqual(p.get(A), -ETH)
  assert.strictEqual(p.get(A) + p.get(B), 0n)
})

check('unsettled, free and refunded wagers move nothing', () => {
  db.exec('DELETE FROM wagers; DELETE FROM battles')
  seq = 0
  settled({ stake: ETH.toString(), feeBps: 250, winnerSide: 0, status: 'awaiting_settlement' })
  settled({ stake: ETH.toString(), feeBps: 250, winnerSide: 0, status: 'refunded' })
  settled({ stake: '0', feeBps: 250, winnerSide: 0 })
  settled({ stake: ETH.toString(), feeBps: 250, winnerSide: 0, onchain: null })
  const p = pnl()
  assert.strictEqual(p.size, 0, `expected nothing counted, got ${JSON.stringify([...p])}`)
})

check('wei precision survives — no float rounding', () => {
  db.exec('DELETE FROM wagers; DELETE FROM battles')
  seq = 0
  // A stake with significant digits all the way down.
  const odd = 1234567890123456789n
  settled({ stake: odd.toString(), feeBps: 137, winnerSide: 0 })
  const p = pnl()
  const fee = (odd * 2n * 137n) / 10000n
  assert.strictEqual(p.get(A), odd - fee)
  assert.strictEqual(p.get(B), -odd)
})

check('many matches accumulate without overflow', () => {
  db.exec('DELETE FROM wagers; DELETE FROM battles')
  seq = 0
  for (let i = 0; i < 500; i++) settled({ stake: (ETH * 5n).toString(), feeBps: 250, winnerSide: 0 })
  const p = pnl()
  const each = ETH * 5n - (ETH * 5n * 2n * 250n) / 10000n
  assert.strictEqual(p.get(A), each * 500n, 'winner total wrong')
  assert.strictEqual(p.get(B), -(ETH * 5n * 500n), 'loser total wrong')
})

console.log(`\n${passed} P/L checks passed${process.exitCode ? ' (with failures)' : ''}`)
process.exit(process.exitCode ?? 0)
