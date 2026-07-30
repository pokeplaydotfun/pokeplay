/**
 * Leaderboard ranking, and specifically that it cannot be farmed.
 *
 * Two accounts trading wins in two tabs is the obvious attack on a free
 * leaderboard, and it takes minutes. This drives that attack directly against
 * the query rather than reasoning about the SQL.
 *
 * Talks to the database the same way the endpoint does, so no server is needed.
 */
import assert from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

const FILE = `/tmp/pp-leaderboard-${randomUUID()}.db`
process.env.DB_PATH = FILE

const { db } = await import('./db.js')

const BOT = '0x000000000000000000000000000000000000b0t5'
const CAP = 3
/**
 * Mirrors the endpoint's default. It was 3, which kept a two-account farm off the board
 * entirely — but only incidentally, since three alts cost a farmer nothing and the same bar
 * hid every honest player who had so far met one opponent. The farm defence that carries the
 * weight is CAP, so these checks now measure the farm in WINS rather than in visibility.
 */
const MIN_OPPONENTS = 1

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`✓ ${name}`) } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`)
    process.exitCode = 1
  }
}

const addr = (n) => '0x' + String(n).padStart(40, '0')

let wagerSeq = 0

/** A free match by default; pass a stake to make it a real wager. */
function battle(winnerAddr, loserAddr, stakeWei = '0') {
  const id = randomUUID()
  let wagerId = null
  if (stakeWei !== '0') {
    wagerId = ++wagerSeq
    db.prepare(
      'INSERT OR IGNORE INTO teams (id,address,name,slots,created_at,updated_at) VALUES (?,?,?,?,0,0)',
    ).run(9000 + wagerId, winnerAddr, 't', '[]')
    db.prepare(`
      INSERT INTO wagers (id, onchain_id, creator, creator_team, opponent, opponent_team,
                          stake_wei, status, battle_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'settled', ?, 0, 0)
    `).run(wagerId, String(wagerId), winnerAddr, 9000 + wagerId, loserAddr, 9000 + wagerId,
           stakeWei, id)
  }
  db.prepare(`
    INSERT INTO battles (id, wager_id, p0, p1, seed, seed_hash, started_at, winner, ended_at)
    VALUES (?, ?, ?, ?, 'seed', 'hash', 0, 0, 1)
  `).run(id, wagerId, winnerAddr, loserAddr)
}

function user(a, name) {
  // created_at is NOT NULL with no default. Omitting it makes OR IGNORE
  // swallow the whole insert, so no user row is ever created — silently.
  db.prepare(
    `INSERT OR IGNORE INTO users (address, name, wins, losses, draws, created_at)
     VALUES (?, ?, 0, 0, 0, 0)`,
  ).run(a, name)
  const row = db.prepare('SELECT 1 FROM users WHERE address = ?').get(a)
  assert.ok(row, `user ${a} was not created`)
}

/** A tournament bracket match: a battle linked from a tournament_matches row,
 *  which the leaderboard treats as "ranked" (uncapped), like a wager. */
let tmSeq = 0
function tournamentBattle(winnerAddr, loserAddr) {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO battles (id, wager_id, p0, p1, seed, seed_hash, started_at, winner, ended_at)
    VALUES (?, NULL, ?, ?, 'seed', 'hash', 0, 0, 1)
  `).run(id, winnerAddr, loserAddr)
  db.prepare(`
    INSERT INTO tournament_matches (id, tournament_id, round, slot, p0, p1, battle_id, winner, status)
    VALUES (?, 1, 0, ?, ?, ?, ?, ?, 'done')
  `).run(9000 + tmSeq, tmSeq, winnerAddr, loserAddr, id, winnerAddr)
  tmSeq++
}

/** The exact query the endpoint runs. */
const leaderboard = () =>
  db.prepare(`
    WITH decided AS (
      SELECT CASE WHEN b.winner = 0 THEN b.p0 ELSE b.p1 END AS victor,
             CASE WHEN b.winner = 0 THEN b.p1 ELSE b.p0 END AS beaten,
             CASE WHEN EXISTS (
               SELECT 1 FROM wagers w WHERE w.id = b.wager_id AND w.stake_wei != '0'
             ) OR EXISTS (
               SELECT 1 FROM tournament_matches tm WHERE tm.battle_id = b.id
             ) THEN 1 ELSE 0 END AS ranked
      FROM battles b
      WHERE b.ended_at IS NOT NULL AND b.winner IS NOT NULL
        AND b.p0 != :bot AND b.p1 != :bot
    ),
    pairs AS (
      SELECT victor AS player, beaten AS foe, ranked, COUNT(*) AS n, 1 AS won FROM decided
      GROUP BY victor, beaten, ranked
      UNION ALL
      SELECT beaten AS player, victor AS foe, ranked, COUNT(*) AS n, 0 AS won FROM decided
      GROUP BY beaten, victor, ranked
    ),
    capped AS (
      SELECT player, foe, won, ranked,
             CASE WHEN ranked = 1 THEN n ELSE MIN(n, :cap) END AS n
      FROM pairs
    ),
    totals AS (
      SELECT player AS address,
             SUM(CASE WHEN won = 1 THEN n ELSE 0 END) AS wins,
             SUM(CASE WHEN won = 0 THEN n ELSE 0 END) AS losses,
             COUNT(DISTINCT foe) AS opponents,
             COUNT(DISTINCT CASE WHEN ranked = 0 THEN foe END) AS free_opponents,
             SUM(CASE WHEN ranked = 1 THEN n ELSE 0 END) AS ranked_played
      FROM capped GROUP BY player
    )
    SELECT t.address, u.name, t.wins, t.losses, t.opponents,
           (t.wins + t.losses) AS played,
           CASE WHEN (t.wins + t.losses) = 0 THEN 0.0
                ELSE CAST(t.wins AS REAL) / (t.wins + t.losses) END AS winrate
    FROM totals t
    LEFT JOIN users u ON u.address = t.address
    WHERE t.ranked_played > 0 OR t.free_opponents >= :minOpponents
    ORDER BY t.wins DESC, winrate DESC, t.losses ASC
    LIMIT 100
  `).all({ bot: BOT, cap: CAP, minOpponents: MIN_OPPONENTS })

/* ------------------------------------------------------------------ */

const farmer = addr(1)
const alt = addr(2)
const honest = addr(3)

user(farmer, 'farmer')
user(alt, 'alt')
user(honest, 'honest')

// The attack: 200 wins against one alt account.
for (let i = 0; i < 200; i++) battle(farmer, alt)

check('200 farmed wins against one alt are worth only the cap', () => {
  const board = leaderboard()
  const row = board.find((r) => r.address === farmer)
  // The farmer is visible now — one real opponent is all it takes to be listed. What must
  // hold is that the farm bought them almost nothing: 200 games, worth 3.
  assert.ok(row, 'farmer should be listed after playing a non-bot opponent')
  assert.strictEqual(
    row.wins, CAP,
    `200 farmed wins counted as ${row.wins}, expected the cap of ${CAP}`,
  )
})

check('an honest player out-ranks the farm on breadth alone', () => {
  // The farm's ceiling is CAP wins from one rival. Anyone who beats CAP+1 distinct people
  // passes it, so the farm can never hold the top of a board with real players on it.
  const wide = addr(90)
  user(wide, 'wide')
  for (let n = 91; n <= 94; n++) {
    user(addr(n), `wideopp${n}`)
    battle(wide, addr(n))
  }
  const board = leaderboard()
  const wideRow = board.find((r) => r.address === wide)
  const farmRow = board.find((r) => r.address === farmer)
  assert.ok(wideRow, 'the honest wide player is missing')
  assert.ok(wideRow.wins > farmRow.wins, `farm ${farmRow.wins} >= honest ${wideRow.wins}`)
  assert.ok(
    board.indexOf(wideRow) < board.indexOf(farmRow),
    'the farm out-ranked an honest player with more distinct wins',
  )
})

check('an honest player with three distinct opponents does rank', () => {
  for (const n of [10, 11, 12]) {
    user(addr(n), `opp${n}`)
    battle(honest, addr(n))
  }
  const row = leaderboard().find((r) => r.address === honest)
  assert.ok(row, 'honest player missing from the board')
  assert.strictEqual(row.wins, 3)
  assert.strictEqual(row.opponents, 3)
})

check('tournament matches are ranked: uncapped AND rank on their own', () => {
  const champ = addr(20)
  const rival = addr(21)
  user(champ, 'champ')
  user(rival, 'rival')
  // A parent tournament row so the bracket-match FK is satisfied.
  db.prepare(`
    INSERT OR IGNORE INTO tournaments (id, name, created_by, entry_fee_wei, max_players, status, created_at)
    VALUES (1, 'Cup', ?, '0', 8, 'finished', 0)
  `).run(champ)
  // Ten bracket wins against ONE rival — a farm if it were free play, but
  // tournament matches are ranked, so all ten count and champ is on the board
  // despite having only a single distinct opponent.
  for (let i = 0; i < 10; i++) tournamentBattle(champ, rival)
  const row = leaderboard().find((r) => r.address === champ)
  assert.ok(row, 'tournament player did not rank')
  assert.strictEqual(row.wins, 10, 'tournament wins were capped like free play')
  assert.strictEqual(row.opponents, 1)
})

check('the farmer stays behind even after reaching the opponent minimum', () => {
  // Farmer now plays two more real people, so they qualify — but those 200
  // wins against one alt must still only be worth the cap.
  for (const n of [20, 21]) {
    user(addr(n), `opp${n}`)
    battle(farmer, addr(n))
  }
  const board = leaderboard()
  const row = board.find((r) => r.address === farmer)
  assert.ok(row, 'farmer should now qualify')
  assert.strictEqual(
    row.wins, CAP + 2,
    `200 farmed wins counted as ${row.wins}, expected ${CAP + 2}`,
  )
})

check('normal repeat matches with a rival still count, up to the cap', () => {
  const rivalA = addr(30)
  const rivalB = addr(31)
  user(rivalA, 'rivalA')
  user(rivalB, 'rivalB')
  battle(rivalA, rivalB)
  battle(rivalA, rivalB)
  const pairs = leaderboard()
  // Two wins is under the cap, so both should be counted in full.
  for (const n of [40, 41]) { user(addr(n), `o${n}`); battle(rivalA, addr(n)) }
  const row = leaderboard().find((r) => r.address === rivalA)
  assert.ok(row, 'rival missing')
  assert.strictEqual(row.wins, 4, `expected 2 rival wins + 2 others, got ${row.wins}`)
  assert.ok(pairs)
})

check('losses are capped the same way, so a farm cannot tank a rival', () => {
  const victim = addr(2) // the alt, who lost 200 times to the farmer
  const row = leaderboard().find((r) => r.address === victim)
  if (row) {
    assert.ok(row.losses <= CAP, `alt carries ${row.losses} losses, expected <= ${CAP}`)
  }
})

check('practice against the bot never reaches the board', () => {
  const solo = addr(50)
  user(solo, 'solo')
  for (let i = 0; i < 10; i++) battle(solo, BOT)
  const row = leaderboard().find((r) => r.address === solo)
  assert.ok(!row, 'practice wins reached the leaderboard')
})

/* ---- paid wagers are exempt from the cap ---- */

check('staked wins are NOT capped — a paid win is a real win', () => {
  const whale = addr(60)
  const foe = addr(61)
  user(whale, 'whale')
  user(foe, 'foe')
  // Ten staked wins against one opponent. Free play would cap this at 3.
  for (let i = 0; i < 10; i++) battle(whale, foe, '10000000000000000')
  const row = leaderboard().find((r) => r.address === whale)
  assert.ok(row, 'a player with staked wins was not ranked')
  assert.strictEqual(row.wins, 10, `staked wins were capped to ${row.wins}`)
})

check('one staked match is enough to be ranked, with no opponent minimum', () => {
  const a = addr(70)
  const b = addr(71)
  user(a, 'stakerA')
  user(b, 'stakerB')
  battle(a, b, '5000000000000000')
  const row = leaderboard().find((r) => r.address === a)
  assert.ok(row, 'a staked player needed three opponents to rank')
  assert.strictEqual(row.wins, 1)
})

check('free play is still capped for someone who also has paid matches', () => {
  const mixed = addr(80)
  const alt = addr(81)
  user(mixed, 'mixed')
  user(alt, 'alt2')
  user(addr(82), 'realfoe')
  for (let i = 0; i < 20; i++) battle(mixed, alt)          // free farm
  battle(mixed, addr(82), '1000000000000000')              // one real wager
  const row = leaderboard().find((r) => r.address === mixed)
  assert.ok(row, 'mixed player not ranked')
  // 3 capped free wins + 1 uncapped paid win.
  assert.strictEqual(row.wins, 4, `expected 4, got ${row.wins}`)
})

console.log(`\n${passed} leaderboard checks passed${process.exitCode ? ' (with failures)' : ''}`)
process.exit(process.exitCode ?? 0)
