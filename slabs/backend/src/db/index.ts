import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA, COLUMN_MIGRATIONS, canTransition, DEPOSITS_TABLE } from "./schema.ts";
import type { OrderStatus, CardState, TreasuryKind } from "./schema.ts";

export type OrderRow = {
  id: number;
  demo: number;
  buyer: string;
  machine_id: string;
  price_usdg: string;
  status: OrderStatus;
  rh_pay_tx: string | null;
  bridge_deposit_tx: string | null;
  bridge_fill_tx: string | null;
  bridge_order_id: string | null;
  cc_open_tx: string | null;
  solana_mint: string | null;
  mirror_token_id: string | null;
  fulfil_tx: string | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  deadline_at: number;
};

/** Mirrors the `buybacks` table. Status order: USER_CONFIRMED -> CC_SOLD -> BRIDGED -> PAID. */
export type BuybackStatus = "QUOTED" | "USER_CONFIRMED" | "CC_SOLD" | "BRIDGED" | "PAID" | "FAILED";

export type BuybackRow = {
  id: number;
  mirror_token_id: string;
  solana_mint: string;
  seller: string;
  cc_quote_bps: number;
  quoted_user_rate_bps: number;
  quoted_usdg: string;
  insured_value_usd: string;
  /** What CC actually paid, recorded at sale time. Null until the sale executes. */
  cc_proceeds_usdc: string | null;
  status: BuybackStatus;
  signature: string | null;
  cc_sell_tx: string | null;
  bridge_order_id: string | null;
  bridge_txs: string | null;
  payout_tx: string | null;
  burn_tx: string | null;
  last_error: string | null;
  quoted_at: number;
  expires_at: number;
  updated_at: number;
};

/**
 * A withdraw request, from the moment `UnwrapRequested` is seen.
 *
 * SEEN   the event is recorded; nothing sent yet
 * SENT   the Solana transfer landed; `transfer_sig` is set; terminal
 * FAILED validation or the transfer failed. NOT terminal — the user is still owed a card
 * HELD   the relayer is switched off, or the card is over the value ceiling. Awaiting a human
 */
export type DepositRow = {
  rowid: number;
  solana_mint: string;
  depositor_evm: string;
  solana_tx: string | null;
  status: "CLAIMED" | "VERIFIED" | "MINTED" | "REJECTED";
  mirror_token_id: string | null;
  deposit_id: number | null;
  last_error: string | null;
  claimed_at: number;
  updated_at: number;
};

export type WithdrawalRow = {
  token_id: string;
  requester: string;
  solana_dest: string;
  solana_mint: string | null;
  /**
   * COLLISION is distinct from HELD on purpose. HELD is resumable — it is what the kill switch
   * and the value ceiling use, and flipping the switch on relays everything queued. A collision
   * must never resume on its own: the row belongs to a different user than the burn that just
   * arrived, so relaying it would send the wrong card to the wrong address.
   */
  status: "SEEN" | "SENT" | "FAILED" | "HELD" | "COLLISION";
  transfer_sig: string | null;
  last_error: string | null;
  seen_at: number;
  updated_at: number;
};

/**
 * Two different orders claim the same id — the DB has one from a previous deployment.
 *
 * Thrown rather than logged because the alternative is losing a paying customer's order in
 * silence, which is exactly what happened once. The worker's tick catches it, alerts, and
 * leaves the order unrecorded so the buyer's permissionless on-chain refund still applies.
 */
export class OrderIdCollision extends Error {
  readonly orderId: number;
  readonly existingBuyer: string;
  readonly incomingBuyer: string;

  constructor(orderId: number, existingBuyer: string, incomingBuyer: string) {
    super(
      `Order id ${orderId} already belongs to ${existingBuyer}, but the chain reports ` +
        `${incomingBuyer}. The database holds an order from a previous deployment. Move the ` +
        `old rows aside before this order can be processed — see docs/SESSION-HANDOFF.md.`,
    );
    this.name = "OrderIdCollision";
    this.orderId = orderId;
    this.existingBuyer = existingBuyer;
    this.incomingBuyer = incomingBuyer;
  }
}

export type EscrowDepositRow = {
  token_id: string;
  depositor: string;
  seen_at: number;
  buyback_id: number | null;
  returned_tx: string | null;
  last_error: string | null;
  updated_at: number;
};

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec(SCHEMA);
    this.raw.exec(DEPOSITS_TABLE);
    this.migrate();
  }

  /**
   * Add columns that SCHEMA declares but an existing database predates.
   *
   * Idempotent and additive: each column is checked against `table_info` first, so a boot
   * against an already-migrated database is a no-op, and a fresh database created from SCHEMA
   * already has them. Nothing is ever dropped or rewritten here.
   */
  private migrate(): void {
    for (const m of COLUMN_MIGRATIONS) {
      const cols = this.raw.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
      if (cols.length === 0) continue; // table not in this database at all
      if (cols.some((c) => c.name === m.column)) continue;
      this.raw.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.definition}`);
    }
  }

  close() {
    this.raw.close();
  }

  /** Wraps fn in a transaction. Any throw rolls the whole thing back. */
  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN");
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  // ------------------------------------------------------------------ orders

  /** Idempotent by design: the on-chain OrderCreated event may be delivered more than once. */
  insertOrder(o: {
    id: number;
    buyer: string;
    machineId: string;
    priceUsdg: string;
    rhPayTx: string | null;
    deadlineAt: number;
    /** Fabricated by the demo server. Excluded from every aggregate that counts as real. */
    demo?: boolean;
  }): void {
    const now = Date.now();

    /**
     * A conflicting id is either a harmless replay or a catastrophic collision. Tell them apart.
     *
     * `ON CONFLICT(id) DO NOTHING` alone treats both the same, and that silently ate a real
     * buyer's order on 20 Jul. Order ids come from the CONTRACT's `nextOrderId`, which restarts
     * at 1 on every redeploy, while this table keys on the bare number with no contract
     * dimension. So the first order on a fresh PackSale collided with an orphaned row from the
     * previous one, the insert did nothing, the worker moved on, and 53 USDG sat in escrow
     * until the deadline refunded it. No error, no log, nothing to notice.
     *
     * Re-seeing the SAME order is normal and must stay cheap — the log scan deliberately
     * replays rather than risk skipping. So: same buyer and price means replay, skip quietly.
     * Anything else means two different orders are claiming one id, which is a data-integrity
     * failure that must never be absorbed silently.
     */
    const existing = this.raw
      .prepare(`SELECT buyer, price_usdg FROM orders WHERE id = ?`)
      .get(o.id) as { buyer: string; price_usdg: string } | undefined;

    if (existing) {
      const sameOrder =
        existing.buyer.toLowerCase() === o.buyer.toLowerCase() && existing.price_usdg === o.priceUsdg;
      if (sameOrder) return; // replay of an order we already have
      throw new OrderIdCollision(o.id, existing.buyer, o.buyer);
    }

    this.raw
      .prepare(
        `INSERT INTO orders (id, buyer, machine_id, price_usdg, status, rh_pay_tx,
                             created_at, updated_at, deadline_at, demo)
         VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(o.id, o.buyer, o.machineId, o.priceUsdg, o.rhPayTx, now, now, o.deadlineAt, o.demo ? 1 : 0);
  }

  getOrder(id: number): OrderRow | undefined {
    return this.raw.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as OrderRow | undefined;
  }

  /**
   * Moves an order along the state machine. Rejects illegal edges loudly — a wrong
   * transition here would corrupt the audit trail that the proof page is built from.
   */
  setOrderStatus(id: number, to: OrderStatus, fields: Partial<OrderRow> = {}): void {
    const order = this.getOrder(id);
    if (!order) throw new Error(`Order ${id} not found`);
    if (order.status === to) return;

    if (!canTransition(order.status, to)) {
      throw new Error(`Illegal order transition ${order.status} -> ${to} for order ${id}`);
    }

    // Belt and braces on the invariant that matters most. The state machine already lacks
    // an OPENING->REFUNDED edge, but an order carrying cc_open_tx must never be refunded by
    // any path, including a FAILED retry loop.
    if (to === "REFUNDED" && order.cc_open_tx) {
      throw new Error(
        `Refusing to refund order ${id}: cc_open_tx ${order.cc_open_tx} exists, so a real ` +
          `pack was opened. This is must-complete (doc 04 §2). If the mint is truly ` +
          `unrecoverable, a human calls PackSale.forceRefund via ops/force-refund.ts.`,
      );
    }

    const allowed = [
      "rh_pay_tx", "bridge_deposit_tx", "bridge_fill_tx", "bridge_order_id",
      "cc_open_tx", "solana_mint", "mirror_token_id", "fulfil_tx", "last_error",
    ] as const;

    const sets: string[] = ["status = ?", "updated_at = ?"];
    const values: (string | number | null)[] = [to, Date.now()];

    for (const key of allowed) {
      if (key in fields) {
        sets.push(`${key} = ?`);
        values.push((fields as Record<string, string | null>)[key] ?? null);
      }
    }

    values.push(id);
    this.raw.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  bumpAttempts(id: number, error: string): void {
    this.raw
      .prepare(`UPDATE orders SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(error.slice(0, 2000), Date.now(), id);
  }

  /** Non-terminal orders, oldest first — the resume set after a crash (doc 04 §8). */
  activeOrders(): OrderRow[] {
    return this.raw
      .prepare(
        `SELECT * FROM orders
          WHERE status NOT IN ('MINTED','REFUNDED','FORCE_REFUNDED')
          ORDER BY created_at ASC`,
      )
      .all() as OrderRow[];
  }

  /**
   * Timed out, never opened a pack — safe to refund on-chain.
   *
   * FAILED is included deliberately, and it is the case that matters most: it is where an
   * order lands after a bridge outage, a sold-out machine, or insufficient Solana USDC. An
   * earlier version listed only CREATED and BRIDGING, which meant the single most common
   * failure path was never auto-refunded at all. FAILED -> REFUNDED is a legal transition.
   *
   * `cc_open_tx IS NULL` is the load-bearing condition, not the status list: it is what
   * guarantees no pack was ever bought. An order that opened a pack must never be
   * auto-refunded — we would be handing back the money while holding the card — and is
   * escalated to the human forceRefund runbook instead.
   */
  refundableOrders(now = Date.now()): OrderRow[] {
    return this.raw
      .prepare(
        `SELECT * FROM orders
          WHERE status IN ('CREATED','BRIDGING','FAILED')
            AND cc_open_tx IS NULL
            AND deadline_at < ?`,
      )
      .all(now) as OrderRow[];
  }

  /**
   * Opened a pack but never minted. These CANNOT be auto-refunded; they page a human and
   * are the only input to the forceRefund runbook.
   */
  strandedOrders(olderThanMs: number, now = Date.now()): OrderRow[] {
    return this.raw
      .prepare(
        `SELECT * FROM orders
          WHERE status IN ('OPENING','REVEALED','FAILED')
            AND cc_open_tx IS NOT NULL
            AND mirror_token_id IS NULL
            AND updated_at <= ?`,
      )
      .all(now - olderThanMs) as OrderRow[];
  }

  // ------------------------------------------------------------------ cards

  insertCard(c: {
    solanaMint: string;
    orderId: number;
    certNumber: string | null;
    grade: string | null;
    name: string | null;
    imageUrl: string | null;
    insuredValueUsd: string | null;
    /** Optional so existing call sites and fixtures keep working; both default to null. */
    imageBackUrl?: string | null;
    tier?: string | null;
    revealAt: number;
    ccWindowEndsAt: number;
    userWindowEndsAt: number;
    ownerMirrorTokenId: string | null;
  }): void {
    const now = Date.now();

    /**
     * A MINT RECURS. This table keys on it, and the insert was ON CONFLICT DO NOTHING.
     *
     * Selling a card back returns it to Collector Crypt, who put it straight back in the
     * machine — so a later pack can pull the SAME solana_mint. The old row then silently won:
     * the new buyer's card would carry someone else's order_id, someone else's (burned) mirror
     * token, a state of SOLD_TO_CC or UNWRAPPED, and windows that expired days ago. Their
     * sell-back would be refused as "card is SOLD_TO_CC", and their withdraw would find no
     * card behind the mirror.
     *
     * Fourth bug in this family, after orders, withdrawals and escrow deposits: a unique key
     * on an identifier that legitimately recurs, plus DO NOTHING, equals a silent swallow.
     *
     * A card in a LEFT state is one we no longer hold, so re-acquiring it is a genuinely new
     * card and the row is replaced wholesale. A card still in CUSTODY is not re-acquirable —
     * we already have it — so that stays DO NOTHING (idempotent replay), and a differing
     * order_id there is a real collision, which is shouted about below.
     */
    const prior = this.raw
      .prepare(`SELECT order_id, state FROM cards WHERE solana_mint = ?`)
      .get(c.solanaMint) as { order_id: number; state: string } | undefined;

    const LEFT_US = new Set(["SOLD_TO_CC", "UNWRAPPED", "BURNED"]);
    if (prior && LEFT_US.has(prior.state)) {
      this.raw
        .prepare(
          `UPDATE cards
              SET order_id = ?, cert_number = ?, grade = ?, name = ?, image_url = ?,
                  image_back_url = ?, tier = ?, insured_value_usd = ?, insured_value_fetched_at = ?,
                  reveal_at = ?, cc_window_ends_at = ?, user_window_ends_at = ?, state = 'CUSTODY',
                  owner_mirror_token_id = ?, updated_at = ?
            WHERE solana_mint = ?`,
        )
        .run(
          c.orderId, c.certNumber, c.grade, c.name, c.imageUrl,
          c.imageBackUrl ?? null, c.tier ?? null,
          c.insuredValueUsd, c.insuredValueUsd ? now : null, c.revealAt,
          c.ccWindowEndsAt, c.userWindowEndsAt, c.ownerMirrorTokenId, now, c.solanaMint,
        );
      return;
    }

    this.raw
      .prepare(
        `INSERT INTO cards (solana_mint, order_id, cert_number, grade, name, image_url,
                            image_back_url, tier,
                            insured_value_usd, insured_value_fetched_at, reveal_at,
                            cc_window_ends_at, user_window_ends_at, state,
                            owner_mirror_token_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CUSTODY', ?, ?, ?)
         ON CONFLICT(solana_mint) DO NOTHING`,
      )
      .run(
        c.solanaMint, c.orderId, c.certNumber, c.grade, c.name, c.imageUrl,
        c.imageBackUrl ?? null, c.tier ?? null,
        c.insuredValueUsd, c.insuredValueUsd ? now : null, c.revealAt,
        c.ccWindowEndsAt, c.userWindowEndsAt, c.ownerMirrorTokenId, now, now,
      );

    // A card we still hold, now claimed by a different order, is not a replay — it means two
    // orders believe they own the same physical card. Never silent.
    if (prior && !LEFT_US.has(prior.state) && prior.order_id !== c.orderId) {
      throw new Error(
        `Card collision on mint ${c.solanaMint}: held for order ${prior.order_id} in state ` +
          `${prior.state}, now claimed by order ${c.orderId}. Refusing to overwrite.`,
      );
    }
  }

  setCardState(solanaMint: string, state: CardState): void {
    this.raw
      .prepare(`UPDATE cards SET state = ?, updated_at = ? WHERE solana_mint = ?`)
      .run(state, Date.now(), solanaMint);
  }

  /**
   * The card backing a mirror token, or undefined if we have never seen that token.
   *
   * Undefined is meaningful to callers, not just an absence: a mirror we hold no card for is
   * one we cannot value, and the value policy refuses what it cannot price.
   */
  cardByMirrorTokenId(mirrorTokenId: string):
    | { solana_mint: string; insured_value_usd: string | null; state: string; origin: string }
    | undefined {
    return this.raw
      .prepare(
        // `origin` is load-bearing: the escrow watcher refuses to sell back a DEPOSIT, and it
        // is the only place that refusal cannot be routed around.
        `SELECT solana_mint, insured_value_usd, state, origin
           FROM cards WHERE owner_mirror_token_id = ?`,
      )
      .get(mirrorTokenId) as
      | { solana_mint: string; insured_value_usd: string | null; state: string; origin: string }
      | undefined;
  }


  // ------------------------------------------------------------------ deposits

  /**
   * Record a claim BEFORE verifying it.
   *
   * A user who sent a card and got nothing must not be invisible to us, so the row exists even
   * when the claim turns out to be bogus. Keyed on the Solana mint, which never recurs — unlike
   * order ids and mirror token ids, both of which restart on a redeploy and have each caused an
   * incident here.
   *
   * A re-claim of a mint we already MINTED leaves the row untouched: that is the idempotent
   * replay, not a second deposit.
   */
  recordDepositClaim(d: { solanaMint: string; depositorEvm: string; solanaTx: string | null }): void {
    const now = Date.now();
    const prior = this.getDeposit(d.solanaMint);
    if (prior?.status === "MINTED") return;

    if (prior) {
      this.raw
        .prepare(
          `UPDATE deposits SET depositor_evm = ?, solana_tx = ?, status = 'CLAIMED', updated_at = ?
            WHERE solana_mint = ?`,
        )
        .run(d.depositorEvm, d.solanaTx, now, d.solanaMint);
      return;
    }

    this.raw
      .prepare(
        `INSERT INTO deposits (solana_mint, depositor_evm, solana_tx, status, claimed_at, updated_at)
         VALUES (?, ?, ?, 'CLAIMED', ?, ?)`,
      )
      .run(d.solanaMint, d.depositorEvm, d.solanaTx, now, now);
  }

  /**
   * Deposits recorded for this wallet that never got a mirror.
   *
   * The resume list. A deposit interrupted after the transfer leaves the card in our vault and
   * the user holding nothing, so it must be finishable — but only by the wallet that claimed
   * it, which is why this is keyed on the recorded depositor rather than on what the vault
   * happens to hold. Anyone being able to finish a stranded deposit is the same front-running
   * hole the claim signature exists to close.
   */
  unfinishedDepositsFor(depositorEvm: string): DepositRow[] {
    return this.raw
      .prepare(
        `SELECT rowid, * FROM deposits
          WHERE lower(depositor_evm) = lower(?) AND status != 'MINTED'
          ORDER BY claimed_at`,
      )
      .all(depositorEvm) as DepositRow[];
  }

  getDeposit(solanaMint: string): DepositRow | undefined {
    return this.raw
      .prepare(`SELECT rowid, * FROM deposits WHERE solana_mint = ?`)
      .get(solanaMint) as DepositRow | undefined;
  }

  setDepositStatus(solanaMint: string, to: string, fields: Partial<DepositRow> = {}): void {
    const sets = ["status = ?", "updated_at = ?"];
    const values: (string | number | null)[] = [to, Date.now()];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      values.push(v as string | number | null);
    }
    values.push(solanaMint);
    this.raw.prepare(`UPDATE deposits SET ${sets.join(", ")} WHERE solana_mint = ?`).run(...values);
  }

  /** Is this mint a card WE hold from a pack? Guards against claiming a mirror for one. */
  cardByMint(solanaMint: string): { solana_mint: string; state: string; origin: string } | undefined {
    return this.raw
      .prepare(`SELECT solana_mint, state, origin FROM cards WHERE solana_mint = ?`)
      .get(solanaMint) as { solana_mint: string; state: string; origin: string } | undefined;
  }

  /**
   * A deposited card, recorded so the collection, withdraw and reserves all see it.
   *
   * origin DEPOSIT is the whole point: it is what stops the card ever being sold back. The
   * windows are set to zero because they govern the sell-back clock, which does not apply — a
   * non-zero value there would imply a sale that can never happen.
   */
  insertDepositedCard(c: {
    solanaMint: string;
    name: string | null;
    imageUrl: string | null;
    ownerMirrorTokenId: string;
  }): void {
    const now = Date.now();
    this.raw
      .prepare(
        `INSERT INTO cards (solana_mint, order_id, cert_number, grade, name, image_url,
                            insured_value_usd, reveal_at, cc_window_ends_at, user_window_ends_at,
                            state, origin, owner_mirror_token_id, created_at, updated_at)
         VALUES (?, NULL, NULL, NULL, ?, ?, NULL, ?, 0, 0, 'CUSTODY', 'DEPOSIT', ?, ?, ?)
         ON CONFLICT(solana_mint) DO UPDATE SET
           owner_mirror_token_id = excluded.owner_mirror_token_id,
           state = 'CUSTODY', origin = 'DEPOSIT',
           -- Reset with everything else. A card that once came from a pack keeps its original
           -- sell window otherwise, so a re-deposited card read as sellable right up until the
           -- escrow watcher refused it and handed the mirror back.
           user_window_ends_at = 0, cc_window_ends_at = 0,
           updated_at = excluded.updated_at`,
      )
      .run(c.solanaMint, c.name, c.imageUrl, now, c.ownerMirrorTokenId, now, now);
  }

  // ------------------------------------------------------------------ buybacks

  /**
   * Record the price a user was shown. Costs nothing and commits nobody: the sell only
   * becomes real when the mirror actually arrives in custody.
   *
   * `requester` is unverified — it comes from a request body. The address we ultimately pay
   * is taken from the on-chain Transfer instead, so a forged requester buys nothing.
   */
  insertQuote(q: {
    mirrorTokenId: string;
    solanaMint: string;
    requester: string;
    ccQuoteBps: number;
    quotedUserRateBps: number;
    quotedUsdg: string;
    insuredValueUsd: string;
    expiresAt: number;
  }): number {
    const now = Date.now();
    this.raw
      .prepare(
        `INSERT INTO buybacks (mirror_token_id, solana_mint, seller, cc_quote_bps,
                               quoted_user_rate_bps, quoted_usdg, insured_value_usd,
                               status, quoted_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'QUOTED', ?, ?, ?)`,
      )
      .run(
        q.mirrorTokenId, q.solanaMint, q.requester, q.ccQuoteBps, q.quotedUserRateBps,
        q.quotedUsdg, q.insuredValueUsd, now, q.expiresAt, now,
      );
    return Number((this.raw.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
  }

  /**
   * The most recent quote that an arriving escrow deposit may be filled against.
   *
   * Matching is deliberately lenient — `maxAgeMs` is generous rather than the 60s the user
   * saw. Being strict here would return a genuine seller's card for being slow, whereas being
   * lenient costs nothing: the pipeline re-quotes before it sells and aborts if the price
   * moved against them. Price safety comes from that check, not from this one.
   *
   * It is also lenient about WHO quoted, which means a stranger can bind a seller's deposit to
   * a quote taken at a worse moment. That is not fixable here: `requester` is unverified, so
   * scoping the match to it would only make an attacker type a different address. It is
   * defused in `sellToCc` instead, which reprices upward so a pinned quote cannot underpay.
   */
  matchableQuoteFor(mirrorTokenId: string, maxAgeMs: number, now = Date.now()): BuybackRow | undefined {
    return this.raw
      .prepare(
        `SELECT * FROM buybacks
          WHERE mirror_token_id = ? AND status = 'QUOTED' AND quoted_at >= ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(mirrorTokenId, now - maxAgeMs) as BuybackRow | undefined;
  }

  /**
   * Turn a quote into a live sell-back, binding it to the address that actually gave up the
   * token. That address comes from the chain, which is what makes the escrow self-
   * authenticating.
   */
  confirmQuote(id: number, seller: string): void {
    this.setBuybackStatus(id, "USER_CONFIRMED", { seller });
  }

  /**
   * Open a sell-back. One in-flight buyback per token, enforced here rather than by a
   * constraint: two rows for one card would race to sell the same Solana NFT.
   */
  insertBuyback(b: {
    mirrorTokenId: string;
    solanaMint: string;
    seller: string;
    ccQuoteBps: number;
    quotedUserRateBps: number;
    quotedUsdg: string;
    insuredValueUsd: string;
    expiresAt: number;
  }): number {
    const now = Date.now();
    const open = this.openBuybackFor(b.mirrorTokenId);
    if (open) throw new Error(`buyback ${open.id} is already in flight for token ${b.mirrorTokenId}`);

    this.raw
      .prepare(
        `INSERT INTO buybacks (mirror_token_id, solana_mint, seller, cc_quote_bps,
                               quoted_user_rate_bps, quoted_usdg, insured_value_usd,
                               status, quoted_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'USER_CONFIRMED', ?, ?, ?)`,
      )
      .run(
        b.mirrorTokenId, b.solanaMint, b.seller, b.ccQuoteBps, b.quotedUserRateBps,
        b.quotedUsdg, b.insuredValueUsd, now, b.expiresAt, now,
      );

    return Number((this.raw.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
  }

  getBuyback(id: number): BuybackRow | undefined {
    return this.raw.prepare(`SELECT * FROM buybacks WHERE id = ?`).get(id) as BuybackRow | undefined;
  }

  /**
   * The one buyback actually working on this token, if any.
   *
   * QUOTED does not count: a quote commits nothing, and several may exist for one token if a
   * user reloads the page. Only a confirmed sell-back holds the card.
   */
  openBuybackFor(mirrorTokenId: string): BuybackRow | undefined {
    return this.raw
      .prepare(
        `SELECT * FROM buybacks
          WHERE mirror_token_id = ? AND status NOT IN ('QUOTED', 'PAID', 'FAILED')
          ORDER BY id DESC LIMIT 1`,
      )
      .get(mirrorTokenId) as BuybackRow | undefined;
  }

  /** Everything the pipeline still owes work on, oldest first. */
  activeBuybacks(): BuybackRow[] {
    return this.raw
      .prepare(
        `SELECT * FROM buybacks WHERE status NOT IN ('QUOTED', 'PAID', 'FAILED') ORDER BY id`,
      )
      .all() as BuybackRow[];
  }

  // ------------------------------------------------------------------ escrow

  /**
   * Note that a mirror has arrived in custody. Idempotent: the same Transfer log may be
   * scanned twice across a restart, and re-recording it must not disturb an in-flight sell.
   */
  recordEscrowDeposit(tokenId: string, depositor: string): void {
    const now = Date.now();

    /**
     * A CLOSED deposit must not block the next one.
     *
     * This table keys on token_id and the insert was ON CONFLICT DO NOTHING, so the row from a
     * finished deposit stayed forever. Deposit a mirror, have the sale fail, get it back, then
     * deposit it again — and the second arrival wrote nothing. The watcher then read the OLD
     * row, saw `buyback_id` and `returned_tx` already set, and skipped it as "already handled";
     * the sweeper ignored it too, because it only considers rows with BOTH null. The mirror sat
     * in custody with nothing driving it and nothing returning it.
     *
     * That happened on the second live sell-back, after the first was returned. Same shape as
     * the order-id collision: a unique key on an id that legitimately recurs.
     *
     * A returned or burned deposit is CLOSED, so a new arrival for that token is a genuinely
     * new deposit and resets the row. An UNRESOLVED row is left alone — that one is either
     * this same deposit seen twice (replay, which must stay idempotent) or a real collision,
     * which the check below still catches.
     */
    const prior = this.getEscrowDeposit(tokenId);
    if (prior && prior.returned_tx !== null) {
      this.raw
        .prepare(
          `UPDATE escrow_deposits
              SET depositor = ?, seen_at = ?, updated_at = ?,
                  buyback_id = NULL, returned_tx = NULL, last_error = NULL
            WHERE token_id = ?`,
        )
        .run(depositor, now, now, tokenId);
      return;
    }

    this.raw
      .prepare(
        `INSERT INTO escrow_deposits (token_id, depositor, seen_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(token_id) DO NOTHING`,
      )
      .run(tokenId, depositor, now, now);

    /**
     * Mirror token ids restart at 1 on a MirrorNFT redeploy, and this table keys on the bare
     * number. A row left over from a previous deployment would silently swallow a real
     * deposit — the same failure that ate an order on 20 Jul. A different depositor for the
     * same id means exactly that, and it must be loud: the user's mirror is already in
     * custody by the time we see it.
     */
    const row = this.getEscrowDeposit(tokenId);
    if (row && row.depositor.toLowerCase() !== depositor.toLowerCase()) {
      throw new Error(
        `Escrow deposit collision on token ${tokenId}: recorded depositor ${row.depositor}, ` +
          `chain reports ${depositor}. A row from a previous deployment is in the way.`,
      );
    }
  }

  getEscrowDeposit(tokenId: string): EscrowDepositRow | undefined {
    return this.raw
      .prepare(`SELECT * FROM escrow_deposits WHERE token_id = ?`)
      .get(tokenId) as EscrowDepositRow | undefined;
  }

  linkEscrowToBuyback(tokenId: string, buybackId: number): void {
    this.raw
      .prepare(`UPDATE escrow_deposits SET buyback_id = ?, updated_at = ? WHERE token_id = ?`)
      .run(buybackId, Date.now(), tokenId);
  }

  /**
   * Deposits we are still holding: no buyback driving them and no return recorded. These are
   * cards we owe back, and the sweeper works this list until it is empty.
   */
  unresolvedEscrowDeposits(): EscrowDepositRow[] {
    return this.raw
      .prepare(
        `SELECT * FROM escrow_deposits
          WHERE returned_tx IS NULL AND buyback_id IS NULL
          ORDER BY seen_at`,
      )
      .all() as EscrowDepositRow[];
  }

  markEscrowReturned(tokenId: string, tx: string): void {
    this.raw
      .prepare(`UPDATE escrow_deposits SET returned_tx = ?, last_error = NULL, updated_at = ? WHERE token_id = ?`)
      .run(tx, Date.now(), tokenId);
  }

  recordEscrowError(tokenId: string, error: string): void {
    this.raw
      .prepare(`UPDATE escrow_deposits SET last_error = ?, updated_at = ? WHERE token_id = ?`)
      .run(error, Date.now(), tokenId);
  }

  /** Release a deposit back to the sweeper when its buyback ended without consuming it. */
  unlinkEscrow(tokenId: string): void {
    this.raw
      .prepare(`UPDATE escrow_deposits SET buyback_id = NULL, updated_at = ? WHERE token_id = ?`)
      .run(Date.now(), tokenId);
  }

  /**
   * Raise a quote to the price the card is actually being sold at.
   *
   * Only ever called with a figure BETTER than the stored one — see `sellToCc`. The seller is
   * paid `quoted_usdg`, so this is what makes a stale quote unable to underpay them.
   */
  repriceQuoteUp(id: number, q: { quotedUsdg: string; ccQuoteBps: number; quotedUserRateBps: number }): void {
    this.raw
      .prepare(
        `UPDATE buybacks SET quoted_usdg = ?, cc_quote_bps = ?, quoted_user_rate_bps = ?,
                             updated_at = ?
          WHERE id = ?`,
      )
      .run(q.quotedUsdg, q.ccQuoteBps, q.quotedUserRateBps, Date.now(), id);
  }

  // ------------------------------------------------------------------ withdrawals

  /**
   * Record a withdraw request. Idempotent: replaying the same log is a no-op.
   *
   * Called BEFORE any validation or transfer, on purpose. The mirror is already burned when
   * this event exists, so the user is owed a card no matter what we decide next — and a
   * request we never wrote down is a user with no trace of their claim.
   */
  recordWithdrawal(w: { tokenId: string; requester: string; solanaDest: string; solanaMint: string | null }): void {
    const now = Date.now();

    /**
     * A COMPLETED withdrawal must not swallow the next one for the same token id.
     *
     * Fifth instance of the family that has now bitten orders, escrow deposits and cards: a
     * unique key on an identifier that legitimately recurs, plus ON CONFLICT DO NOTHING. Mirror
     * token ids restart at 1 on a MirrorNFT redeploy, so the SAME user can burn token 1 again.
     * The requester then matches, so the collision check in the relayer never fires; the old
     * SENT row is returned by `getWithdrawal`; and `openWithdrawals` excludes it because it has
     * a signature. Nothing is queued and nothing is alerted — for a mirror that is already
     * burned.
     *
     * A SENT row is closed, so a new request for that token is genuinely new and resets it.
     * Anything unresolved is left alone: that is either this same event replayed, which must
     * stay idempotent, or a real collision, which the relayer catches and holds.
     */
    const prior = this.getWithdrawal(w.tokenId);
    if (prior && prior.transfer_sig !== null) {
      this.raw
        .prepare(
          `UPDATE withdrawals
              SET requester = ?, solana_dest = ?, solana_mint = ?, status = 'SEEN',
                  transfer_sig = NULL, last_error = NULL, seen_at = ?, updated_at = ?
            WHERE token_id = ?`,
        )
        .run(w.requester, w.solanaDest, w.solanaMint, now, now, w.tokenId);
      return;
    }

    this.raw
      .prepare(
        `INSERT INTO withdrawals (token_id, requester, solana_dest, solana_mint, status, seen_at, updated_at)
         VALUES (?, ?, ?, ?, 'SEEN', ?, ?)
         ON CONFLICT(token_id) DO NOTHING`,
      )
      .run(w.tokenId, w.requester, w.solanaDest, w.solanaMint, now, now);
  }

  getWithdrawal(tokenId: string): WithdrawalRow | undefined {
    return this.raw.prepare(`SELECT * FROM withdrawals WHERE token_id = ?`).get(tokenId) as
      | WithdrawalRow
      | undefined;
  }

  /** Everything not yet sent. FAILED rows are included: a failure here is owed, not closed. */
  openWithdrawals(): WithdrawalRow[] {
    return this.raw
      .prepare(`SELECT * FROM withdrawals WHERE transfer_sig IS NULL ORDER BY seen_at ASC`)
      .all() as WithdrawalRow[];
  }

  setWithdrawalStatus(tokenId: string, to: string, fields: Partial<WithdrawalRow> = {}): void {
    const sets = ["status = ?", "updated_at = ?"];
    const values: (string | number | null)[] = [to, Date.now()];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      values.push(v as string | number | null);
    }
    values.push(tokenId);
    this.raw.prepare(`UPDATE withdrawals SET ${sets.join(", ")} WHERE token_id = ?`).run(...values);
  }

  setBuybackStatus(id: number, to: BuybackStatus, fields: Partial<BuybackRow> = {}): void {
    const sets = ["status = ?", "updated_at = ?"];
    const values: (string | number | null)[] = [to, Date.now()];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      values.push(v as string | number | null);
    }
    values.push(id);
    this.raw.prepare(`UPDATE buybacks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  // ------------------------------------------------------------------ treasury

  recordTreasury(e: {
    kind: TreasuryKind;
    amount: string;
    token: string;
    chain: string;
    tx?: string | null;
    orderId?: number | null;
    note?: string | null;
  }): void {
    this.raw
      .prepare(
        `INSERT INTO treasury_events (kind, amount, token, chain, tx, order_id, note, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.kind, e.amount, e.token, e.chain, e.tx ?? null, e.orderId ?? null, e.note ?? null, Date.now());
  }

  /** Doc 06 §6 / doc 04 §6: count rule — 2 inside 7 days auto-pauses new packs. */
  forceRefundsSince(sinceMs: number): number {
    const row = this.raw
      .prepare(`SELECT COUNT(*) AS n FROM treasury_events WHERE kind = 'FORCE_REFUND' AND at >= ?`)
      .get(sinceMs) as { n: number };
    return row.n;
  }

  totalOrderCount(): number {
    return (this.raw.prepare(`SELECT COUNT(*) AS n FROM orders`).get() as { n: number }).n;
  }

  // ------------------------------------------------------------------ intents

  /**
   * Reserve an intent before an external send. Returns the existing row if one is already
   * recorded — the caller must then check the chain rather than sending again.
   */
  claimIntent(key: string, kind: string, payload: unknown): { fresh: boolean; tx: string | null } {
    const existing = this.raw.prepare(`SELECT tx FROM intents WHERE key = ?`).get(key) as
      | { tx: string | null }
      | undefined;
    if (existing) return { fresh: false, tx: existing.tx };

    const now = Date.now();
    this.raw
      .prepare(
        `INSERT INTO intents (key, kind, payload, status, created_at, updated_at)
         VALUES (?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(key, kind, JSON.stringify(payload), now, now);
    return { fresh: true, tx: null };
  }

  /**
   * Release a claimed intent that provably never spent anything.
   *
   * Only safe when the caller KNOWS no transaction was broadcast — for an EVM send, that
   * means its on-broadcast callback never fired. Clearing a claim that did spend would let
   * the next attempt spend again, which is the whole failure this table exists to prevent.
   */
  clearIntent(key: string): void {
    this.raw.prepare(`DELETE FROM intents WHERE key = ? AND tx IS NULL`).run(key);
  }

  /**
   * Release an intent whose recorded transaction is CONFIRMED REVERTED, so the next tick can
   * make a fresh attempt.
   *
   * `clearIntent` cannot do this: it deletes only `WHERE tx IS NULL`, by design, so a claim
   * with a hash against it is never dropped on a guess. But `recordIntentTx(key, tx, "FAILED")`
   * leaves the hash in place, which meant a reverted payout re-entered the same branch every
   * tick — re-checking the same dead hash, re-alerting, and NEVER RE-BROADCASTING. The seller
   * of a card already handed to Collector Crypt was owed money that could not arrive, and the
   * comment beside it said "Will retry".
   *
   * Only ever call this on a definite `txSucceeded === false`. An unknown must not reach here:
   * releasing a claim whose transaction actually landed is how a payout gets sent twice.
   */
  releaseRevertedIntent(key: string): void {
    this.raw.prepare(`DELETE FROM intents WHERE key = ?`).run(key);
  }

  /**
   * Has this intent been claimed at all, regardless of whether a tx was recorded?
   *
   * The ambiguous middle state matters: claimed-but-no-tx means an external call may have
   * gone out and we do not know. Callers that would otherwise UNDO something must treat that
   * as "it happened" rather than "it did not".
   */
  intentExists(key: string): boolean {
    return this.raw.prepare(`SELECT 1 FROM intents WHERE key = ?`).get(key) !== undefined;
  }

  recordIntentTx(key: string, tx: string, status: "SENT" | "CONFIRMED" | "FAILED" = "SENT"): void {
    this.raw
      .prepare(`UPDATE intents SET tx = ?, status = ?, updated_at = ? WHERE key = ?`)
      .run(tx, status, Date.now(), key);
  }

  // ------------------------------------------------------------------ user settings

  getUserSettings(evmAddress: string): { solanaAddress: string | null; lastNonce: number } {
    const row = this.raw
      .prepare(`SELECT solana_address, last_nonce FROM user_settings WHERE evm_address = ?`)
      .get(evmAddress.toLowerCase()) as { solana_address: string | null; last_nonce: number } | undefined;
    return { solanaAddress: row?.solana_address ?? null, lastNonce: row?.last_nonce ?? 0 };
  }

  setUserSolanaAddress(evmAddress: string, solanaAddress: string | null, nonce: number): void {
    this.raw
      .prepare(
        `INSERT INTO user_settings (evm_address, solana_address, updated_at, last_nonce)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(evm_address) DO UPDATE SET
           solana_address = excluded.solana_address,
           updated_at     = excluded.updated_at,
           last_nonce     = excluded.last_nonce`,
      )
      .run(evmAddress.toLowerCase(), solanaAddress, Date.now(), nonce);
  }

  // ------------------------------------------------------------------ meta

  getMeta(key: string): string | undefined {
    return (this.raw.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.raw
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`)
      .run(key, value, value);
  }
}
