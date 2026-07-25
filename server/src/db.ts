import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const FILE = process.env.DB_PATH ?? new URL('../data/app.db', import.meta.url).pathname
mkdirSync(dirname(FILE), { recursive: true })

export const db = new DatabaseSync(FILE)

db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  address     TEXT PRIMARY KEY,          -- lowercased 0x address
  name        TEXT,
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  draws       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  address     TEXT NOT NULL REFERENCES users(address),
  name        TEXT NOT NULL,
  slots       TEXT NOT NULL,             -- JSON TeamSlot[]
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_addr ON teams(address);

CREATE TABLE IF NOT EXISTS wagers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  onchain_id    TEXT,                    -- escrow wager id, null for free play
  creator       TEXT NOT NULL REFERENCES users(address),
  creator_team  INTEGER NOT NULL REFERENCES teams(id),
  opponent      TEXT REFERENCES users(address),
  opponent_team INTEGER REFERENCES teams(id),
  stake_wei     TEXT NOT NULL DEFAULT '0',
  status        TEXT NOT NULL,           -- open|matched|playing|settled|cancelled
  battle_id     TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wagers_status ON wagers(status);

CREATE TABLE IF NOT EXISTS battles (
  id            TEXT PRIMARY KEY,        -- uuid
  wager_id      INTEGER REFERENCES wagers(id),
  p0            TEXT NOT NULL,
  p1            TEXT NOT NULL,
  seed          TEXT NOT NULL,
  seed_hash     TEXT NOT NULL,
  winner        INTEGER,                 -- 0 | 1 | null (draw/unfinished)
  log           TEXT,                    -- JSON event log, written at the end
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_battles_players ON battles(p0, p1);

CREATE TABLE IF NOT EXISTS tournaments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(address),
  entry_fee_wei TEXT NOT NULL DEFAULT '0',
  max_players   INTEGER NOT NULL,
  status        TEXT NOT NULL,           -- open|running|finished|cancelled
  winner        TEXT,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);

CREATE TABLE IF NOT EXISTS tournament_entries (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  address       TEXT NOT NULL REFERENCES users(address),
  team_id       INTEGER NOT NULL REFERENCES teams(id),
  seed          INTEGER NOT NULL,
  joined_at     INTEGER NOT NULL,
  PRIMARY KEY (tournament_id, address)
);

CREATE TABLE IF NOT EXISTS tournament_matches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  round         INTEGER NOT NULL,
  slot          INTEGER NOT NULL,
  p0            TEXT,
  p1            TEXT,
  battle_id     TEXT,
  winner        TEXT,
  status        TEXT NOT NULL,           -- pending|ready|playing|done
  UNIQUE (tournament_id, round, slot)
);
CREATE INDEX IF NOT EXISTS idx_tmatches_tournament ON tournament_matches(tournament_id);

-- Single-use login challenges (SIWE-lite).
CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  issued_at  INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`)

/**
 * Additive migrations. SQLite has no `ADD COLUMN IF NOT EXISTS`, so each is
 * attempted and a duplicate-column error is treated as already-applied.
 */
function addColumn(table: string, column: string, decl: string) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
  } catch (e) {
    if (!/duplicate column/i.test((e as Error).message)) throw e
  }
}

// Replay needs the exact teams and the ordered list of decisions. Re-running
// those against the recorded seed reproduces the match move for move, which is
// what makes the published seed commitment worth anything.
addColumn('battles', 'p0_team', 'TEXT')
addColumn('battles', 'p1_team', 'TEXT')
addColumn('battles', 'steps', 'TEXT')
addColumn('battles', 'forced', 'INTEGER')

// The fee in force when a wager settled, so profit/loss stays correct even if
// the contract's fee is changed later. Null until a paid wager settles.
addColumn('wagers', 'fee_bps', 'INTEGER')

// A username is claimed once, with a wallet signature, and never changes. The
// signature is kept so the claim stays auditable.
addColumn('users', 'name_signature', 'TEXT')
addColumn('users', 'name_claimed_at', 'INTEGER')

// Opt-in wallet privacy. When set, the address is never sent to anyone but its
// owner — masked server-side on the leaderboard, wager board and in opponents'
// match history. Enforced in the API, not just hidden in the UI.
addColumn('users', 'hide_wallet', 'INTEGER NOT NULL DEFAULT 0')

// The PokePlayTournamentPool tournament id backing a PAID tournament. Null for
// free tournaments. The on-chain pool is the source of truth for who paid in;
// the server seats an entrant only after the contract confirms they did.
addColumn('tournaments', 'onchain_id', 'TEXT')
// The fee in force when a paid tournament settled, so prize/PL stays correct if
// the pool's fee is later changed. Null until it settles.
addColumn('tournaments', 'fee_bps', 'INTEGER')
// Reconciled on-chain outcome of a paid tournament's pot: null = not yet
// resolved (the champion still has to settle), 1 = settled (winner paid),
// 2 = refunded (timed out or cancelled — the prize was NOT paid). The health
// check flags a paid, finished tournament that sits at null for too long.
addColumn('tournaments', 'settled_onchain', 'INTEGER')
// When sign-ups close and the bracket auto-starts, as a unix timestamp. For a
// paid tournament this mirrors the pool's on-chain registrationDeadline (joins
// close there too). Null means no timer — an admin starts it by hand. The
// scheduler starts any open tournament whose start_at has passed with >= 2
// players in, and this can be pushed out later with an "extend".
addColumn('tournaments', 'start_at', 'INTEGER')

// Case-insensitive uniqueness, enforced by the database rather than by a
// check-then-insert in the handler: two people claiming the same name at the
// same moment would both pass that check.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name_unique
    ON users(lower(name)) WHERE name IS NOT NULL
`)

export const now = () => Math.floor(Date.now() / 1000)

export function ensureUser(address: string) {
  db.prepare(
    'INSERT INTO users (address, created_at) VALUES (?, ?) ON CONFLICT(address) DO NOTHING',
  ).run(address, now())
}
