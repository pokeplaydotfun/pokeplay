/**
 * SQLite schema (doc 02 §2). Uses node:sqlite — built into Node 22+, so there is no native
 * build step to break on the VPS.
 *
 * Money is stored as TEXT holding integer base units (6dp USDG/USDC). Never REAL: floats
 * silently lose cents, and every number here is either a user's money or our margin.
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS orders (
  id                 INTEGER PRIMARY KEY,          -- also the on-chain orderId
  buyer              TEXT NOT NULL,
  machine_id         TEXT NOT NULL,
  price_usdg         TEXT NOT NULL,
  status             TEXT NOT NULL,
  -- CREATED|BRIDGING|OPENING|REVEALED|MINTED|REFUNDED|FORCE_REFUNDED|FAILED
  rh_pay_tx          TEXT,
  bridge_deposit_tx  TEXT,
  bridge_fill_tx     TEXT,
  bridge_order_id    TEXT,
  cc_open_tx         TEXT,   -- Solana signature. Its presence forbids auto-refund, forever.
  solana_mint        TEXT,
  mirror_token_id    TEXT,
  fulfil_tx          TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  -- 1 for an order fabricated by the demo server, which never paid and never minted. Demo
  -- rows must never reach the leaderboard, a collection, or the reserves count. Browser demo
  -- pulls never create a row at all; this covers the /demo/rip path, so the guarantee is
  -- structural rather than a side effect of that route being disabled in production.
  demo               INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deadline_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_deadline ON orders(deadline_at) WHERE status NOT IN
  ('MINTED','REFUNDED','FORCE_REFUNDED','FAILED');
CREATE INDEX IF NOT EXISTS idx_orders_buyer    ON orders(buyer);

CREATE TABLE IF NOT EXISTS cards (
  solana_mint             TEXT PRIMARY KEY,
  order_id                INTEGER REFERENCES orders(id),
  -- PACK (pulled from a machine) or DEPOSIT (sent in by a user). A DEPOSIT can never be sold
  -- back: we did not buy it, so there are no proceeds of ours to return. Enforced where the
  -- mirror ARRIVES, not only in the API — see escrow.ts.
  origin                  TEXT NOT NULL DEFAULT 'PACK',
  cert_number             TEXT,
  grade                   TEXT,
  name                    TEXT,
  image_url               TEXT,
  -- Slab back. The reveal opens on this face before turning to the front, so dropping it
  -- left the first beat rendering nothing at all.
  image_back_url          TEXT,
  -- Assigned against THIS machine's value bands at reveal time. It cannot be recomputed
  -- later from insured value alone: $500 is epic in the $50 machine and uncommon in the
  -- $250, whose epic band starts at $2000.
  tier                    TEXT,
  insured_value_usd       TEXT,
  insured_value_fetched_at INTEGER,
  reveal_at               INTEGER NOT NULL,
  cc_window_ends_at       INTEGER NOT NULL,   -- reveal + 72h
  user_window_ends_at     INTEGER NOT NULL,   -- reveal + 66h
  state                   TEXT NOT NULL,
  -- CUSTODY|SOLD_TO_CC|UNWRAPPED|BURNED|SALVAGE
  owner_mirror_token_id   TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_state  ON cards(state);
CREATE INDEX IF NOT EXISTS idx_cards_mirror ON cards(owner_mirror_token_id);

CREATE TABLE IF NOT EXISTS buybacks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  mirror_token_id     TEXT NOT NULL,
  solana_mint         TEXT REFERENCES cards(solana_mint),
  seller              TEXT NOT NULL,
  cc_quote_bps        INTEGER NOT NULL,
  quoted_user_rate_bps INTEGER NOT NULL,
  quoted_usdg         TEXT NOT NULL,
  -- What CC actually paid, from buildBuyback rather than derived from the quote. This is the
  -- amount that gets bridged; quoted_usdg is only what the seller is owed out of it.
  cc_proceeds_usdc    TEXT,
  insured_value_usd   TEXT NOT NULL,
  status              TEXT NOT NULL,
  -- QUOTED|USER_CONFIRMED|CC_SOLD|BRIDGED|PAID|FAILED
  signature           TEXT,        -- the user's EIP-712 sell intent
  cc_sell_tx          TEXT,
  bridge_order_id     TEXT,
  bridge_txs          TEXT,
  payout_tx           TEXT,
  burn_tx             TEXT,
  last_error          TEXT,
  quoted_at           INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_buybacks_status ON buybacks(status);
CREATE INDEX IF NOT EXISTS idx_buybacks_token  ON buybacks(mirror_token_id);

CREATE TABLE IF NOT EXISTS unwraps (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  mirror_token_id     TEXT NOT NULL,
  solana_mint         TEXT REFERENCES cards(solana_mint),
  dest_solana_address TEXT NOT NULL,
  fee_usdg            TEXT NOT NULL DEFAULT '0',
  status              TEXT NOT NULL,     -- REQUESTED|TRANSFERRING|DONE|FAILED
  burn_tx             TEXT,
  transfer_tx         TEXT,
  last_error          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_unwraps_status ON unwraps(status);

CREATE TABLE IF NOT EXISTS treasury_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  -- PACK_REVENUE|SPREAD_REVENUE|UNWRAP_FEE|BRIDGE_FEE|GAS|REFUND|FORCE_REFUND|PROFIT_SWEEP
  amount     TEXT NOT NULL,
  token      TEXT NOT NULL,
  chain      TEXT NOT NULL,
  tx         TEXT,
  order_id   INTEGER REFERENCES orders(id),
  note       TEXT,
  at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_treasury_kind ON treasury_events(kind);
CREATE INDEX IF NOT EXISTS idx_treasury_at   ON treasury_events(at);

/*
 * Idempotency guard for every external send (doc 04 §8). A row is written BEFORE the send;
 * on restart the worker checks the chain for the recorded tx rather than re-sending. This
 * is what stops a crash mid-bridge from spending twice.
 */
CREATE TABLE IF NOT EXISTS intents (
  key        TEXT PRIMARY KEY,     -- e.g. "bridge-out:order:42"
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  tx         TEXT,
  status     TEXT NOT NULL,        -- PENDING|SENT|CONFIRMED|FAILED
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Per-wallet settings that must survive a logout, a new browser and a new device.
-- localStorage alone is not persistence: it is per-browser and one "clear site data" from
-- being gone, which for a withdraw address is the difference between a card arriving and a
-- support ticket.
--
-- Writes are authenticated by a signature from the EVM wallet itself (see /settings in the
-- API), so nobody can set somebody else's withdraw address.
CREATE TABLE IF NOT EXISTS user_settings (
  evm_address    TEXT PRIMARY KEY,   -- lowercased
  solana_address TEXT,
  updated_at     INTEGER NOT NULL,
  -- Kept so a replayed signature cannot roll an address back to an older value.
  last_nonce     INTEGER NOT NULL DEFAULT 0
);

-- Every mirror that has arrived in operator custody for a sell-back.
--
-- This table exists so that holding someone's card is never a state we can forget. A deposit
-- with no buyback driving it and no return recorded is, by definition, a card we owe back,
-- and the sweeper retries until that is resolved. Without a durable record, a failed return
-- would leave the token sitting in our wallet with nothing to notice it.
--
-- Keyed by token, because a mirror can only be in our custody once at a time.
CREATE TABLE IF NOT EXISTS escrow_deposits (
  token_id     TEXT PRIMARY KEY,
  depositor    TEXT NOT NULL,       -- taken from the on-chain Transfer, never from a request
  seen_at      INTEGER NOT NULL,
  buyback_id   INTEGER,             -- set once matched; the pipeline then owns the token
  returned_tx  TEXT,                -- set once handed back; terminal
  last_error   TEXT,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_escrow_open ON escrow_deposits(returned_tx, buyback_id);

/**
 * Withdraw requests, one row per UnwrapRequested event.
 *
 * The row is written BEFORE anything is attempted, and that ordering is the whole point. The
 * mirror is already burned by the time we see the event — the user holds nothing and is owed a
 * physical card — so an unrecorded request is indistinguishable from a user who was robbed. A
 * recorded one can always be relayed by hand.
 *
 * Keyed on token_id because a mirror can only be burned once, which makes replaying the same
 * log harmless: the insert is ignored rather than queued twice.
 */
CREATE TABLE IF NOT EXISTS withdrawals (
  token_id      TEXT PRIMARY KEY,
  requester     TEXT NOT NULL,       -- from the event, never from a request body
  solana_dest   TEXT NOT NULL,       -- decoded from the event's raw 32 bytes
  solana_mint   TEXT,                -- resolved from our own card row
  status        TEXT NOT NULL,       -- SEEN | SENT | FAILED | HELD
  transfer_sig  TEXT,                -- set the instant it exists; terminal
  last_error    TEXT,
  seen_at       INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_open ON withdrawals(status);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Columns added to tables that already exist in a live database.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing once a table is there, so a new column in SCHEMA
 * only reaches fresh databases. Every one also needs an entry here or production silently
 * runs without it.
 *
 * Additive only, and each must be nullable or carry a default — there is no rewrite step and
 * existing rows cannot be back-filled by an ALTER.
 */
/**
 * Cards sent IN by users, mirrored on Robinhood Chain.
 *
 * Keyed on the Solana mint, because that is the physical card and one card may back exactly
 * one mirror. The row is written when a deposit is CLAIMED and before anything is minted, so
 * a claim we failed to record cannot become a card we hold with no trace of who sent it.
 *
 * Deliberately NOT keyed on anything that recurs. Mirror token ids restart on a MirrorNFT
 * redeploy and order ids restart on a PackSale redeploy; a Solana mint address never repeats.
 */
export const DEPOSITS_TABLE = `
CREATE TABLE IF NOT EXISTS deposits (
  solana_mint    TEXT PRIMARY KEY,
  depositor_evm  TEXT NOT NULL,        -- where the mirror is minted to
  solana_tx      TEXT,                 -- the transfer the user says moved it
  status         TEXT NOT NULL,        -- CLAIMED|VERIFIED|MINTED|REJECTED
  mirror_token_id TEXT,
  deposit_id     INTEGER,              -- synthetic id, >= Fulfiller.DEPOSIT_ID_BASE
  last_error     TEXT,
  claimed_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
`;

export const COLUMN_MIGRATIONS: { table: string; column: string; definition: string }[] = [
  { table: "buybacks", column: "cc_proceeds_usdc", definition: "TEXT" },
  { table: "cards", column: "image_back_url", definition: "TEXT" },
  { table: "cards", column: "tier", definition: "TEXT" },
  { table: "orders", column: "demo", definition: "INTEGER NOT NULL DEFAULT 0" },
  // Existing rows are all pack pulls, which is exactly what the default says.
  { table: "cards", column: "origin", definition: "TEXT NOT NULL DEFAULT 'PACK'" },
];

export type OrderStatus =
  | "CREATED"
  | "BRIDGING"
  | "OPENING"
  | "REVEALED"
  | "MINTED"
  | "REFUNDED"
  | "FORCE_REFUNDED"
  | "FAILED";

export type CardState = "CUSTODY" | "SOLD_TO_CC" | "UNWRAPPED" | "BURNED" | "SALVAGE";

export type TreasuryKind =
  | "PACK_REVENUE"
  | "SPREAD_REVENUE"
  | "UNWRAP_FEE"
  | "BRIDGE_FEE"
  | "GAS"
  | "REFUND"
  | "FORCE_REFUND"
  | "PROFIT_SWEEP";

/**
 * Legal order transitions. The worker may only move along these edges; anything else is a
 * bug and throws rather than silently corrupting an order's history.
 *
 * Note what is deliberately absent: there is no edge from OPENING or later back to
 * REFUNDED. Once cc_open_tx exists a pack was really opened, and the only way out is the
 * human-triggered forceRefund (doc 06 runbook 6), which the worker cannot reach.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CREATED: ["BRIDGING", "REFUNDED", "FAILED"],
  BRIDGING: ["OPENING", "REFUNDED", "FAILED"],
  OPENING: ["REVEALED", "FAILED"],
  REVEALED: ["MINTED", "FAILED"],
  MINTED: [],
  REFUNDED: [],
  FORCE_REFUNDED: [],
  // Retryable. CREATED is included so an order that failed BEFORE bridging can re-enter at
  // the bridge step rather than being pushed forward to a purchase it cannot fund.
  FAILED: ["CREATED", "BRIDGING", "OPENING", "REVEALED", "MINTED", "REFUNDED"],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}
