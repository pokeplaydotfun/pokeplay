/**
 * The fulfilment worker.
 *
 * Watches Robinhood Chain for OrderCreated, drives each order through the pipeline, and
 * mints the mirror. This is the process that turns a payment into a card.
 *
 * Three rules it will not break:
 *
 *  1. It refuses to start unless every dependency is real and reachable. A worker that boots
 *     with a broken RPC and silently processes nothing is worse than one that will not boot.
 *  2. It stops taking new work when either gas wallet runs low, rather than accepting orders
 *     it cannot finish. A stuck order holds someone's money.
 *  3. USE_MOCKS is the hard switch. With it on, nothing here can spend.
 */
import { keccak256, toHex } from "viem";
import { loadConfig, type Config } from "./config.ts";
import { Db } from "./db/index.ts";
import { PonsReader } from "./pons.ts";
import { NativePrice } from "./bridge/native-price.ts";
import { RhChain, assertMachineIdRoundTrip, revertErrorName } from "./chains/rh.ts";
import { SolanaChain, MIN_SOL_LAMPORTS } from "./chains/solana.ts";
import { CollectorCryptApi, signCcTransaction } from "./cc/client.ts";
import type { CollectorCryptClient } from "./cc/types.ts";
import { MockCollectorCrypt } from "./cc/mock.ts";
import { DeBridgeClient } from "./bridge/debridge.ts";
import { MockBridge } from "./bridge/mock.ts";
import { dbIdempotencyStore } from "./bridge/store.ts";
import { JitSource } from "./bridge/jit-source.ts";
import { FulfillmentPipeline, type MirrorMinter, type SolanaSigner } from "./pipeline/fulfill.ts";
import { BuybackPipeline } from "./pipeline/buyback.ts";
import { DepositPipeline, CC_COLLECTION } from "./pipeline/deposit.ts";
import { EscrowWatcher } from "./pipeline/escrow.ts";
import { WithdrawRelayer } from "./pipeline/withdraw.ts";

/**
 * 10s, not the 4s this ran at originally.
 *
 * The RH public RPC was answering 429 Too Many Requests around 58 times a day. Nothing was
 * malformed — viem reports a 429 as "Missing or invalid parameters", which sent us looking
 * for a bad argument that was never there. The ranges were 75-130 blocks. It was purely the
 * request rate: three watchers, each doing headBlock + getLogs, every 4 seconds, forever.
 *
 * Halving the rate matters more than it sounds, because a 429 on the FIRST chunk of a scan
 * rethrows and leaves the cursor unmoved. Isolated 429s are absorbed by the next tick;
 * sustained ones would stop the watchers advancing at all, and that gets worse exactly when
 * traffic goes up.
 */
const TICK_MS = 10_000;

/**
 * A gap between the RPC-heavy watchers inside one tick.
 *
 * They already run sequentially, but back to back: three getLogs bursts inside a few hundred
 * milliseconds, which is what a rate limiter counts. Spreading them across the tick costs
 * nothing — the work is idle waiting on a chain where usually nothing has happened.
 */
const STAGGER_MS = 1_200;
const stagger = () => new Promise<void>((r) => setTimeout(r, STAGGER_MS));


/** Below this the worker cannot fund an outbound bridge plus the mint transaction. */
/** Control-flow signal: skip taking on new work this tick, but still run the sweeps below. */
class SkipIngestion extends Error {}

const MIN_ETH_WEI = 5_000_000_000_000_000n; // 0.005 ETH, ~4 opens of headroom

/**
 * The machines we sell. Every one must ALSO be enabled on chain with setMachine — this list
 * only decides which ids the worker recognises and offers; the chain decides what can be
 * bought. Collector Crypt runs many more, several at the same price as each other.
 */
const MACHINES = ["pokemon_50", "pokemon_250", "pokemon_1000", "water_100"] as const;

/**
 * The worker's handle, plus the dependencies it built. `main.ts` mounts the API on these
 * same instances rather than constructing a second set: two `Db` handles on one SQLite file
 * would be two write paths to the same rows.
 */
export type WorkerHandle = {
  stop: () => void;
  db: Db;
  cc: CollectorCryptClient;
  pipeline: FulfillmentPipeline;
  cfg: Config;
  /** Operator custody address, where a seller sends their mirror to start a sell-back. */
  escrowAddress: string;
  /** Machines actually enabled on chain, so the UI never offers one that would revert. */
  enabledMachineIds: () => Promise<Set<string>>;
  /** Whether PackSale is paused on chain, briefly cached. Surfaced by /health. */
  isPaused: () => Promise<boolean>;
  /** $PWA's Pons reads for the token page. `configured` is false until launch. */
  pons: PonsReader;
  /** Current on-chain holders of mirrors. The collection is built from this. */
  mirrorOwners: (ids: bigint[]) => Promise<Map<string, string | null>>;
  /** Deposit listing, claiming and status, served by /deposit/*. */
  deposits: {
    vaultAddress: string;
    cardsOf(owner: string): Promise<{ mint: string; name: string | null; imageUrl: string | null }[]>;
    transferTx(mint: string, owner: string): Promise<string>;
    supported(): Promise<boolean>;
    pendingFor(evm: string): { solanaMint: string; status: string; error: string | null }[];
    claim(p: { solanaMint: string; depositorEvm: string; solanaTx: string | null }): Promise<void>;
    status(mint: string): { status: string; mirrorTokenId: string | null; error: string | null } | null;
  };
};

export async function startWorker(cfg: Config = loadConfig()): Promise<WorkerHandle> {
  // A machine id encoded differently here than in the frontend means every buy reverts, and
  // nothing on chain can detect it. Fail at boot rather than in production.
  assertMachineIdRoundTrip([...MACHINES]);

  const db = new Db(cfg.db.path);
  const rh = new RhChain(cfg);
  const solana = new SolanaChain(cfg);

  const cc = cfg.useMocks
    ? new MockCollectorCrypt()
    : new CollectorCryptApi({ apiUrl: cfg.cc.apiUrl, apiKey: cfg.cc.apiKey, referralCode: cfg.cc.referralCode });

  const bridge = cfg.useMocks
    ? new MockBridge()
    : new DeBridgeClient(cfg, {
        store: dbIdempotencyStore(db),
        evm: {
          sendTransaction: (tx, onSent) => rh.sendRaw(tx, onSent),
          ensureAllowance: (token, spender, amount) => rh.ensureAllowance(token, spender, amount),
        },
        solana: {
          signAndSend: (b64, onSent) => solana.signAndSend(b64, onSent),
        },
      });

  const signer: SolanaSigner = {
    address: solana.address,
    signBase64: (b64) => signCcTransaction(b64, solana.keypair),
  };

  const minter: MirrorMinter = {
    fulfill: async (p) => {
      const r = await rh.fulfillOrder({
        orderId: BigInt(p.orderId),
        expectedBuyer: p.buyer as `0x${string}`,
        meta: {
          solanaMintHash: hashMint(p.solanaMint),
          ccOpenTxHash: hashMint(p.ccOpenTx),
          ...cardWindowsForChain(p.revealAt, cfg.economics.userWindowHours, cfg.economics.ccWindowHours),
        },
        tokenUri: p.tokenUri,
        ccTxSigHash: hashMint(p.ccOpenTx),
      });
      return { tokenId: r.tokenId.toString(), txHash: r.txHash };
    },
  };

  const buybacks = new BuybackPipeline({
    db,
    cc,
    cfg,
    chain: {
      operatorAddress: rh.workerAddress,
      mirrorOwnerOf: (id) => rh.mirrorOwnerOf(id),
      returnMirror: (to, id) => rh.returnMirror(to as `0x${string}`, id),
      payUsdg: (to, amount, onSent) => rh.payUsdg(to as `0x${string}`, amount, onSent),
      usdgBalance: () => rh.usdgBalance(),
      burnAfterSell: (id) => rh.burnAfterSell(id),
      txSucceeded: (hash) => rh.txSucceeded(hash),
    },
    // Same composition as the pack purchase: sign locally, submit through CC. NOT
    // solana.signAndSend, which signs again internally and would double-sign.
    signer: {
      signAndSubmit: async (b64, solanaMint) => {
        // The mint is passed so the buyback guard can verify THIS card is the one moving.
        const signed = signCcTransaction(b64, solana.keypair, solanaMint);
        const { signature } = await cc.submitTransaction(signed);
        return signature;
      },
    },
    /**
     * The inbound leg, Solana USDC back to RH USDG.
     *
     * `DeBridgeClient.execute` is already direction-agnostic — it dispatches to `sendSolana`
     * when the source is Solana — so this is wiring, not new bridge code. It inherits the
     * same cost gate and the same idempotency store as the outbound leg, keyed here on the
     * buyback id so a crash mid-flight rejoins the existing transfer instead of sending twice.
     *
     * It has still never run against the real network. `cfg.sellBackEnabled` is what keeps it
     * unreachable until it has.
     */
    bridge: {
      toRhChain: async ({ amountUsdc, reference }) => {
        const quote = await bridge.quote("solana", "rh", amountUsdc);
        const r = await bridge.execute("solana", "rh", amountUsdc, quote, reference);
        return {
          orderId: r.providerOrderId,
          txs: [r.depositTx, r.fillTx].filter((t): t is string => Boolean(t)),
        };
      },
    },
    cardOwner: (mint) => solana.assetOwner(mint),
    alert: (m) => console.error(`[ALERT] ${m}`),
  });

  /**
   * The deposit pipeline. Verification is entirely chain-read, so this needs no watcher and no
   * cursor: a claim triggers a read, and the read either proves the card arrived or it does not.
   */
  const depositPipeline = new DepositPipeline({
    db,
    cfg,
    chain: { asset: (mint) => solana.depositAsset(mint) },
    minter: {
      mintForDeposit: async (p) => {
        const r = await rh.mintForDeposit({
          to: p.to as `0x${string}`,
          depositId: BigInt(p.depositId),
          solanaMint: p.solanaMint,
          tokenUri: `https://collectorcrypt.com/assets/solana/${p.solanaMint}`,
        });
        return { tokenId: r.tokenId.toString(), txHash: r.txHash };
      },
    },
    alert: (m) => console.error(`[ALERT] ${m}`),
  });

  const escrow = new EscrowWatcher({
    db,
    cfg,
    buybacks,
    chain: {
      operatorAddress: rh.workerAddress,
      headBlock: () => rh.headBlock(),
      inboundMirrorTransfers: (from, to) => rh.inboundMirrorTransfers(from, to),
      mirrorOwnerOf: (id) => rh.mirrorOwnerOf(id),
      returnMirror: (to, id) => rh.returnMirror(to as `0x${string}`, id),
    },
    alert: (m) => console.error(`[ALERT] ${m}`),
  });

  /**
   * The withdraw relayer.
   *
   * Constructed unconditionally, even with WITHDRAW_ENABLED off. Off means "do not send", NOT
   * "do not watch": burnForUnwrap burns the mirror before we ever see the event, so a request
   * we failed to record is a user holding nothing with no trace of their claim. Watching
   * always, sending only when switched on, is the difference between a queue and a loss.
   */
  const withdrawals = new WithdrawRelayer({
    db,
    cfg,
    chain: {
      headBlock: () => rh.headBlock(),
      unwrapRequests: (from) => rh.unwrapRequests(from),
    },
    solana: {
      assetOwner: (mint) => solana.assetOwner(mint),
      withdrawAssetTo: (mint, dest, opts) => solana.withdrawAssetTo(mint, dest, opts),
    },
    alert: (m) => console.error(`[ALERT] ${m}`),
  });

  /**
   * Ask the CONTRACT whether it supports drawing, rather than assuming.
   *
   * With the draw: the buyer's own payment funds their pack, and the worker needs no working
   * capital. Without it: the worker fronts the pack price from its own USDG and is reimbursed
   * when escrow releases at markFulfilled.
   *
   * Both are correct; only one matches whatever is deployed. Deciding here means the contract
   * and the worker can be deployed in either order without a window where every order fails.
   */
  const draw = await rh.drawSupport();
  if (draw.supported) {
    if (draw.drawer?.toLowerCase() !== rh.workerAddress.toLowerCase()) {
      throw new Error(
        `PackSale.drawer is ${draw.drawer} but this worker is ${rh.workerAddress}. It cannot ` +
          `draw, so every order would fail at the bridge. Run setDrawer(${rh.workerAddress}).`,
      );
    }
    console.log("draw mode  buyers fund their own packs; no worker float needed");
  } else {
    console.log(
      "draw mode  NOT supported by this PackSale — the worker must FRONT each pack price " +
        "from its own USDG and is reimbursed at markFulfilled. Keep it funded.",
    );
  }

  const pipeline = new FulfillmentPipeline({
    db,
    cc,
    liquidity: new JitSource(bridge, db, cfg, (m) => console.warn(`[bridge] ${m}`)),
    signer,
    minter,
    cfg,
    // Points at our own API rather than arweave: the metadata has to carry the CC image and
    // the grade, and those are ours to serve. Immutable storage is the eventual home.
    tokenUriFor: (orderId, mint) => `${cfg.api.publicUrl}/metadata/${orderId}/${mint}`,
    alert: (m) => console.error(`[ALERT] ${m}`),
    // The chain is the authority on whether an order is still ours to spend against. Both of
    // these are wired only in the real worker: demo.ts has no chain, and passing them as
    // callbacks keeps the pipeline free of an RhChain dependency for tests.
    onChainOrder: async (orderId) => {
      const o = await rh.getOrder(BigInt(orderId));
      return o.status === "NONE" ? null : { status: o.status, deadline: o.deadline };
    },
    refundOrder: async (orderId) => rh.refundOrder(BigInt(orderId)),
    solanaUsdcBalance: () => solana.usdcBalance(),
    assetFrozen: (mint) => solana.assetFrozen(mint),
    // Wired only when the deployed contract actually has it.
    drawForOpen: draw.supported ? (orderId) => rh.drawForOpen(BigInt(orderId)) : undefined,
    refundDrawnOrder: (buyer, amount, onSent) => rh.payUsdg(buyer as `0x${string}`, BigInt(amount), onSent),
    txSucceeded: (hash) => rh.txSucceeded(hash),
    revertErrorName,
    expectedBridgeArrival: async (amountUsdg: string) => {
      const q = await bridge.quote("rh", "solana", amountUsdg);
      return BigInt(q.amountOut);
    },
    closeDrawnOrder: draw.supported
      ? (orderId, reason) => rh.closeDrawnOrder(BigInt(orderId), reason)
      : undefined,
    // The chain's record of which mirror an order minted. Only consulted when a mint was
    // broadcast but its result never recorded — the one case where our own tables cannot say.
    mintedTokenFor: (orderId) => rh.mintedTokenFor(BigInt(orderId)),
  });

  console.log(`worker up  rh=${rh.workerAddress}  solana=${solana.address}  mocks=${cfg.useMocks}`);

  let stopped = false;
  let pausedCache: { value: boolean; at: number } | null = null;
  let cursor = BigInt(db.getMeta("rh_block_cursor") ?? "0");
  if (cursor === 0n) {
    // First boot: start from now rather than replaying the whole chain.
    cursor = await rh.headBlock();
    db.setMeta("rh_block_cursor", cursor.toString());
  }

  const tick = async () => {
    if (stopped) return;
    /**
     * The readiness gate stops us TAKING ON new work. It must not stop us returning money.
     *
     * This used to `return` out of the whole tick, which skipped the escrow sweep and the
     * refund sweep further down. So the moment the worker ran low on gas it also stopped
     * refunding buyers and stopped handing back escrowed mirrors — exactly when those matter
     * most, and directly contradicting the comment below explaining that the sweeps get their
     * own try block so an unrelated failure cannot hold up somebody's money.
     *
     * A refund and a mirror return are cheap and are owed. Ingestion is what has to wait.
     */
    let gateOk = true;
    try {
      const gate = await readiness(rh, solana);
      gateOk = gate.ok;
      if (!gate.ok) console.warn(`[paused, still refunding] ${gate.reasons.join("; ")}`);
    } catch (e) {
      gateOk = false;
      console.error("readiness check failed:", e instanceof Error ? e.message : e);
    }

    try {
      if (!gateOk) throw new SkipIngestion();

      const { orders, latestBlock } = await rh.getOrdersSince(cursor + 1n);
      for (const o of orders) {
        const existing = db.getOrder(Number(o.orderId));

        /**
         * An existing row is NOT proof we already have this order.
         *
         * `if (!existing) insert` treated any row with the same id as "already seen", and on
         * 20 Jul that silently discarded a real buyer's order: the contract had been
         * redeployed, `nextOrderId` restarted at 1, and the database still held order 1 from
         * the previous deployment. The worker skipped it, logged nothing, and 53 USDG sat in
         * escrow until the deadline refunded it.
         *
         * A genuine replay has the SAME buyer. A different buyer means two orders are
         * claiming one id, which needs a human — so it is shouted about rather than skipped,
         * every tick, because the alternative is a paying customer disappearing in silence.
         *
         * "Every tick" was not true. This used to `continue`, and the cursor advanced
         * unconditionally after the loop — so the block was never rescanned and the alert
         * fired exactly ONCE, for an order whose payment is sitting in escrow. It now throws,
         * which leaves the cursor where it is: the tick retries, the alert really does repeat,
         * and the collision cannot scroll off into silence.
         */
        if (existing && existing.buyer.toLowerCase() !== o.buyer.toLowerCase()) {
          throw new Error(
            `ORDER ID COLLISION on ${o.orderId}: the database holds an order for ` +
              `${existing.buyer} but the chain reports ${o.buyer}. This order is NOT being ` +
              `processed. Its payment is still in escrow and refundable on chain after the ` +
              `deadline. A row from a previous deployment is in the way — move it aside and ` +
              `rewind rh_block_cursor to re-ingest. Refusing to advance the cursor past it.`,
          );
        }

        if (!existing) {
          db.insertOrder({
            id: Number(o.orderId),
            buyer: o.buyer,
            machineId: o.machineCode,
            priceUsdg: o.price.toString(),
            rhPayTx: null,
            // The contract's own deadline, so our timeout can never disagree with the one
            // that actually governs refunds.
            deadlineAt: o.deadline * 1000,
          });
          console.log(`order ${o.orderId} seen  buyer=${o.buyer}  machine=${o.machineCode}`);
        }
      }
      cursor = latestBlock;
      db.setMeta("rh_block_cursor", cursor.toString());

      for (const row of db.activeOrders()) {
        try {
          await pipeline.processOrder(row.id);
        } catch (e) {
          console.error(`order ${row.id} failed:`, e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      if (!(e instanceof SkipIngestion)) {
        console.error("tick failed:", e instanceof Error ? e.message : e);
      }
    }

    await stagger();

    // Kept out of the try above on purpose: an order-watching failure must not stop us from
    // resolving escrow. Somebody's card sitting in custody is more urgent than a missed block.
    try {
      await escrow.tick();
      await buybacks.resumeAll();
    } catch (e) {
      console.error("escrow tick failed:", e instanceof Error ? e.message : e);
    }

    // Its own try for the same reason as escrow: a buyer waiting on money we owe them must
    // not be held up by an unrelated RPC failure elsewhere in the tick. This also unblocks
    // the store — openOrderCount only decrements on fulfil or refund, and maxOpenOrders is 5.
    try {
      await pipeline.refundTimedOut();
    } catch (e) {
      console.error("refund sweep failed:", e instanceof Error ? e.message : e);
    }

    // Isolated for the sharpest version of the same reason. Everyone in this queue has ALREADY
    // burned their mirror and is owed a physical card, so an unrelated failure elsewhere in
    // the tick must never be what stops us recording or relaying their claim.
    await stagger();

    try {
      await withdrawals.tick();
    } catch (e) {
      console.error("withdraw tick failed:", e instanceof Error ? e.message : e);
    }
  };

  /**
   * One tick at a time. The interval is TICK_MS; a tick routinely runs far longer.
   *
   * A bridge fill alone can take 180s (`bridge.fillTimeoutMs`), awaitReveal is 20 x 3s, and
   * receipt waits are up to 120s. So ticks were piling up on top of each other, each
   * iterating the SAME `db.activeOrders()` rows. Two ticks on one order could:
   *
   *   - both see `!fresh && !tx` on the bridge intent and send a SECOND deposit
   *   - or race the cc-open intent and fail the order with "claimed with no memo recorded",
   *     an incident report for something that was never actually wrong
   *
   * Skipping rather than queueing is deliberate: the next tick is only TICK_MS away, and a
   * backlog of queued ticks would just recreate the pile-up more slowly.
   */
  let ticking = false;
  const guardedTick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await tick();
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => void guardedTick(), TICK_MS);
  void guardedTick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      db.raw.close();
    },
    db,
    cc,
    pipeline,
    cfg,
    escrowAddress: rh.workerAddress,
    /**
     * $PWA's on-chain numbers for the token page.
     *
     * Constructed unconditionally: `configured` is false until PONS_TOKEN_ADDRESS is set, and
     * /token/stats reports `live: false` in that state. So launching is a matter of setting
     * two env vars and restarting, with no code change and no second deploy to remember.
     *
     * NativePrice is constructed with its real signature — (fetchImpl, fallback) — because
     * passing a config object to it once silently produced a $300/SOL fallback and a payout
     * figure that was wrong by more than double.
     */
    pons: new PonsReader(cfg, () => new NativePrice().usd("ETH")),
    // The collection is built from on-chain ownership, so transfers and marketplace sales
    // move cards between collections the way they move the mirror.
    mirrorOwners: (ids) => rh.mirrorOwners(ids),

    /**
     * Deposits. Wired only when Solana is configured, which it always is in production and
     * never is in the demo server — so /deposit/* reports unavailable rather than half-working.
     */
    deposits: {
      vaultAddress: cfg.solana.operatorAddress,
      cardsOf: (owner) => solana.collectorCryptCardsOf(owner, CC_COLLECTION),
      transferTx: (mint, owner) => solana.buildDepositTransfer(mint, owner),
      supported: () => rh.depositsSupported(),
      pendingFor: (evm) =>
        db.unfinishedDepositsFor(evm).map((d) => ({
          solanaMint: d.solana_mint,
          status: d.status,
          error: d.last_error,
        })),
      claim: (p) => depositPipeline.process(p.solanaMint, p.depositorEvm, p.solanaTx),
      status: (mint) => {
        const d = db.getDeposit(mint);
        return d
          ? { status: d.status, mirrorTokenId: d.mirror_token_id, error: d.last_error }
          : null;
      },
    },
    /**
     * Cached briefly on purpose. /health is unauthenticated and uncached, so without this a
     * burst of traffic turns into a burst of RPC reads. A pause is an operator action
     * measured in minutes; five seconds of staleness costs nothing.
     */
    isPaused: async () => {
      const now = Date.now();
      if (pausedCache && now - pausedCache.at < 5_000) return pausedCache.value;
      const value = await rh.isPaused();
      pausedCache = { value, at: now };
      return value;
    },
    /**
     * Asked of the chain rather than assumed from MACHINES: this list is what the UI offers,
     * and offering a machine whose `buy` reverts costs a user gas and a confusing failure.
     */
    enabledMachineIds: async () => {
      /**
       * All or nothing, deliberately.
       *
       * This previously caught per machine and skipped the ones that failed, so a single
       * transient RPC error silently removed a product from the store — and the caller's
       * 30s cache then served that truncated menu to everyone. It was observed doing exactly
       * that to Water 100.
       *
       * Throwing instead lets the caller keep its last known-good set, which is the correct
       * response to "we could not read the chain just now": show what we last knew, not less.
       * Read in parallel so one slow call cannot cascade into a timeout for the rest.
       */
      const results = await Promise.all(
        MACHINES.map(async (code) => ({ code, live: (await rh.machineIsLive(code)).enabled })),
      );
      return new Set(results.filter((r) => r.live).map((r) => r.code));
    },
  };
}

/** Both wallets must be able to pay before we take on more work. */
async function readiness(rh: RhChain, solana: SolanaChain) {
  const reasons: string[] = [];
  const [wei, sol] = await Promise.all([rh.workerGasBalance(), solana.solBalance()]);
  if (wei < MIN_ETH_WEI) reasons.push(`worker ETH ${Number(wei) / 1e18} below minimum`);
  if (sol < MIN_SOL_LAMPORTS) reasons.push(`operator SOL ${sol / 1e9} below minimum`);
  return { ok: reasons.length === 0, reasons };
}

/**
 * CardMeta stores HASHES of the Solana mint and the CC open tx, not the values themselves.
 * The originals live in our database; the chain carries a commitment to them.
 */
function hashMint(s: string): `0x${string}` {
  return keccak256(toHex(s));
}

/**
 * The card's reveal time and its two windows, in the units the CHAIN uses.
 *
 * Milliseconds in, SECONDS out. `revealAt` is a `Date.now()` epoch everywhere off chain
 * (cc/client.ts, and the `cards` table via fulfill.ts), but `MirrorNFT` compares CardMeta
 * against `block.timestamp`, which is seconds.
 *
 * This was wrong until 19 Jul 2026 and it wrote IMMUTABLE on-chain values: the code added
 * `hours * 3600` to a millisecond epoch. Two consequences, both permanent per token:
 *
 *   1. The windows were ~4 minutes wide (66 * 3600 ms) instead of 66 and 72 hours.
 *   2. Far worse, a ms epoch stored in a uint64 the contract reads as seconds lands roughly
 *      55,000 years in the future, so `block.timestamp < ccWindowEndsAt` (MirrorNFT.sol:162,
 *      :180) is permanently true. With `unwrapFeeBps` live at 500, the 5% unwrap fee would
 *      have applied forever, on every card ever minted, uncorrectably.
 *
 * The database copies stay in milliseconds and are correct. The two are deliberately in
 * different units — never "align" them by copying one into the other.
 */
export function cardWindowsForChain(
  revealAtMs: number,
  userWindowHours: number,
  ccWindowHours: number,
): { revealAt: number; userWindowEndsAt: number; ccWindowEndsAt: number } {
  const revealAt = Math.floor(revealAtMs / 1000);
  return {
    revealAt,
    userWindowEndsAt: revealAt + userWindowHours * 3600,
    ccWindowEndsAt: revealAt + ccWindowHours * 3600,
  };
}

if (import.meta.filename === process.argv[1]) {
  startWorker().catch((e) => {
    console.error("worker failed to start:", e);
    process.exit(1);
  });
}
