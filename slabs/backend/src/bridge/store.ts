/**
 * Durable idempotency for bridge transfers.
 *
 * The in-memory default in DeBridgeClient survives nothing, and a worker that restarts
 * between "deposit sent" and "fill confirmed" would otherwise have no way to know it had
 * already paid. This backs that record with the `intents` table, which exists precisely so
 * an external send can be reserved before it happens.
 *
 * The order id is stored alongside the tx because deBridge's tx -> order lookup is a network
 * call that can fail exactly when we most need it, during recovery.
 */
import type { Db } from "../db/index.ts";
import type { IdempotencyStore } from "./debridge.ts";

export function dbIdempotencyStore(db: Db): IdempotencyStore {
  return {
    async get(key) {
      const row = db.raw.prepare(`SELECT tx, payload FROM intents WHERE key = ?`).get(key) as
        | { tx: string | null; payload: string }
        | undefined;
      if (!row?.tx) return null;

      let orderId: string | undefined;
      try {
        orderId = (JSON.parse(row.payload) as { orderId?: string }).orderId;
      } catch {
        // A malformed payload must not block recovery: the tx hash alone is enough, because
        // deBridge can map it back to an order.
      }
      return { depositTx: row.tx, orderId };
    },

    async set(key, value) {
      // claimIntent is a no-op when the row already exists, which is the desired behaviour:
      // this method is also reached on a retry of an already-recorded transfer.
      db.claimIntent(key, "bridge", { orderId: value.orderId });
      db.raw
        .prepare(`UPDATE intents SET tx = ?, payload = ?, status = 'SENT', updated_at = ? WHERE key = ?`)
        .run(value.depositTx, JSON.stringify({ orderId: value.orderId }), Date.now(), key);
    },
  };
}
