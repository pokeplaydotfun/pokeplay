#!/usr/bin/env node
/**
 * Demo leaderboard data.
 *
 * These are invented players, not real results. They use a recognisable
 * address pattern (0x1111…1111 through 0x8888…8888) so removing them later is
 * unambiguous — nothing a real wallet could ever collide with.
 *
 *   node scripts/demo-leaderboard.mjs            seed
 *   node scripts/demo-leaderboard.mjs --undo     remove every trace
 *
 * DB_PATH selects the database. Real results are never touched either way.
 */
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

const DB = process.env.DB_PATH ?? '/var/lib/slabshowdown/app.db'
const undo = process.argv.includes('--undo')

const db = new DatabaseSync(DB)

/** The tell-tale shape: 40 identical hex digits. */
const PLAYERS = [
  { name: 'bluesteel', d: '1' },
  { name: 'nidoqueenz', d: '2' },
  { name: null, d: '3' },
  { name: 'gastly.eth', d: '4' },
  { name: 'tauros', d: '5' },
  { name: null, d: '6' },
  { name: 'zapdos99', d: '7' },
  { name: 'mrmime', d: '8' },
].map((p) => ({ ...p, addr: '0x' + p.d.repeat(40) }))

const ADDRS = PLAYERS.map((p) => p.addr)
const PLACEHOLDERS = ADDRS.map(() => '?').join(',')

if (undo) {
  const battles = db.prepare(
    `DELETE FROM battles WHERE p0 IN (${PLACEHOLDERS}) OR p1 IN (${PLACEHOLDERS})`,
  ).run(...ADDRS, ...ADDRS)
  const users = db.prepare(`DELETE FROM users WHERE address IN (${PLACEHOLDERS})`).run(...ADDRS)
  console.log(`removed ${battles.changes} demo battles and ${users.changes} demo players`)
  process.exit(0)
}

for (const p of PLAYERS) {
  // created_at is NOT NULL with no default; omit it and OR IGNORE silently
  // swallows the whole insert.
  db.prepare(
    `INSERT OR IGNORE INTO users (address, name, wins, losses, draws, created_at)
     VALUES (?, ?, 0, 0, 0, ?)`,
  ).run(p.addr, p.name, Math.floor(Date.now() / 1000))
}

const battle = (winner, loser) => {
  db.prepare(`
    INSERT INTO battles (id, wager_id, p0, p1, seed, seed_hash, started_at, winner, ended_at)
    VALUES (?, NULL, ?, ?, 'demo', 'demo', ?, 0, ?)
  `).run(randomUUID(), winner, loser, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000))
  db.prepare('UPDATE users SET wins = wins + 1 WHERE address = ?').run(winner)
  db.prepare('UPDATE users SET losses = losses + 1 WHERE address = ?').run(loser)
}

// A plausible spread: everyone faces several distinct opponents, stronger
// players win more often. Deterministic, so the board is stable.
const strength = new Map(PLAYERS.map((p, i) => [p.addr, PLAYERS.length - i]))
let n = 0
for (let i = 0; i < PLAYERS.length; i++) {
  for (let j = i + 1; j < PLAYERS.length; j++) {
    const a = PLAYERS[i].addr
    const b = PLAYERS[j].addr
    for (let g = 0; g < 1 + ((i + j) % 3); g++) {
      const upset = (n++ % 4) === 0
      const strongerFirst = strength.get(a) >= strength.get(b)
      const winner = upset ? (strongerFirst ? b : a) : (strongerFirst ? a : b)
      battle(winner, winner === a ? b : a)
    }
  }
}

db.prepare('UPDATE users SET draws = 1 WHERE address IN (?, ?)').run(
  PLAYERS[1].addr, PLAYERS[3].addr,
)

const total = db.prepare(
  `SELECT COUNT(*) AS n FROM battles WHERE p0 IN (${PLACEHOLDERS})`,
).get(...ADDRS)

console.log(`seeded ${PLAYERS.length} demo players and ${total.n} battles`)
console.log('remove with:  node scripts/demo-leaderboard.mjs --undo')
