/**
 * Renders the leaderboard with realistic data, locally, so it can be looked at.
 *
 * Deliberately NOT a production seeder. The live site shows real results only —
 * this writes to a scratch database that is thrown away afterwards.
 */
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'

const DB = process.env.DB_PATH ?? '/tmp/pp-preview.db'
const SITE = process.env.SITE ?? 'http://127.0.0.1:4173'
const SHOTS = new URL('./dry-run/shots/', import.meta.url).pathname

const db = new DatabaseSync(DB)

const PLAYERS = [
  { name: 'bluesteel', addr: '0x1111111111111111111111111111111111111111' },
  { name: 'nidoqueenz', addr: '0x2222222222222222222222222222222222222222' },
  { name: null, addr: '0x3333333333333333333333333333333333333333' },
  { name: 'gastly.eth', addr: '0x4444444444444444444444444444444444444444' },
  { name: 'tauros', addr: '0x5555555555555555555555555555555555555555' },
  { name: null, addr: '0x6666666666666666666666666666666666666666' },
  { name: 'zapdos99', addr: '0x7777777777777777777777777777777777777777' },
  { name: 'mrmime', addr: '0x8888888888888888888888888888888888888888' },
]

for (const p of PLAYERS) {
  // created_at is NOT NULL with no default — omitting it made OR IGNORE
  // swallow every insert and the table came out empty.
  db.prepare(
    'INSERT OR IGNORE INTO users (address, name, wins, losses, draws, created_at) VALUES (?, ?, 0, 0, 0, 0)',
  ).run(p.addr, p.name)
}

const battle = (winner, loser) => {
  db.prepare(`
    INSERT INTO battles (id, wager_id, p0, p1, seed, seed_hash, started_at, winner, ended_at)
    VALUES (?, NULL, ?, ?, 'seed', 'hash', 0, 0, 1)
  `).run(randomUUID(), winner, loser)
  db.prepare('UPDATE users SET wins = wins + 1 WHERE address = ?').run(winner)
  db.prepare('UPDATE users SET losses = losses + 1 WHERE address = ?').run(loser)
}

// A plausible spread: everyone plays several distinct opponents, with the
// stronger players winning more. Deterministic, so the picture is stable.
const strength = new Map(PLAYERS.map((p, i) => [p.addr, PLAYERS.length - i]))
let n = 0
for (let i = 0; i < PLAYERS.length; i++) {
  for (let j = i + 1; j < PLAYERS.length; j++) {
    const a = PLAYERS[i].addr
    const b = PLAYERS[j].addr
    const games = 1 + ((i + j) % 3)
    for (let g = 0; g < games; g++) {
      // The stronger player usually wins, but not always.
      const upset = (n++ % 4) === 0
      const strongerFirst = strength.get(a) >= strength.get(b)
      const winner = upset ? (strongerFirst ? b : a) : (strongerFirst ? a : b)
      battle(winner, winner === a ? b : a)
    }
  }
}

// A couple of draws, so that column is not always zero.
db.prepare('UPDATE users SET draws = 1 WHERE address IN (?, ?)').run(
  PLAYERS[1].addr, PLAYERS[3].addr,
)

console.log(`seeded ${PLAYERS.length} players`)

/* ---- screenshot ---------------------------------------------------- */

const browser = await chromium.launch()

for (const [label, viewport] of [
  ['leaderboard-desktop', { width: 1280, height: 1000 }],
  ['leaderboard-mobile', { width: 390, height: 900 }],
]) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  await page.goto(`${SITE}/leaderboard`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${SHOTS}${label}.png`, fullPage: false })
  const rows = await page.locator('.lb tbody tr').count()
  console.log(`  ${label}: ${rows} rows rendered`)
  await ctx.close()
}

await browser.close()
