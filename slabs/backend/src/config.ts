import { privateKeyToAddress } from "viem/accounts";
import { asSolanaAddress, type SolanaAddress } from "./chains/address.ts";
/**
 * Typed configuration (doc 02 §7). Single source of truth for the worker.
 *
 * Values that ENFORCE a user-facing promise live on-chain (caps, pause, price) — these are
 * the worker's view of them. Where the two can disagree, on-chain wins and the worker is
 * expected to reconcile, never to override.
 */
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/**
 * An env var with a default.
 *
 * Treats EMPTY as absent, which `??` does not. A key written but left blank —
 * `USDC_SOLANA_MINT=` — reaches dotenv as "" rather than undefined, so `??`
 * happily returns the empty string and the default never fires. That is almost
 * never what a blank line means: someone left a placeholder unfilled, and they
 * expect the default.
 *
 * This cost a crash loop on first deploy. usdcMint became "" and the worker
 * died in `new PublicKey("")` with "Invalid public key input" — an error that
 * names neither the variable nor the file, three frames below where the empty
 * string was introduced. A .env.example listing every key, which is good
 * practice, makes this MORE likely, because copying it produces exactly these
 * blank lines.
 */
function optional(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got "${raw}"`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

export type Config = ReturnType<typeof loadConfig>;

/**
 * A private key, normalised to the 0x form viem requires.
 *
 * Tooling disagrees about the prefix: cast and our preflight script accept a bare hex
 * string, viem and forge's vm.envUint reject it. Normalising in one place means a key
 * pasted either way works everywhere, instead of passing one check and failing another.
 */
function hexKey(name: string): `0x${string}` {
  const raw = required(name).trim();
  const hex = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${name} is not a 32-byte hex private key (got ${hex.length - 2} hex chars)`);
  }
  return hex;
}

export function loadConfig() {
  const cfg = {
    env: optional("NODE_ENV", "development"),
    /** When true, CC and bridge clients are mocks. The ONLY safe mode until doc 01 T1-T3 land. */
    useMocks: bool("USE_MOCKS", true),

    rh: {
      rpcUrl: required("RH_RPC_URL"),
      wsUrl: process.env.RH_WS_URL,
      chainId: 4663,
      usdgAddress: required("USDG_ADDRESS") as `0x${string}`,
      packSaleAddress: required("PACK_SALE_ADDRESS") as `0x${string}`,
      mirrorAddress: required("MIRROR_NFT_ADDRESS") as `0x${string}`,
      fulfillerAddress: required("FULFILLER_ADDRESS") as `0x${string}`,
      /**
       * Optional: the backend does not transact on the Marketplace, the frontend does. Loaded
       * so operational scripts can read listings and approvals without a second env parser.
       * `optional` rather than `required` so a deployment without a marketplace still boots.
       */
      marketplaceAddress: process.env.MARKETPLACE_ADDRESS as `0x${string}` | undefined,
      /**
       * Worker hot key. Must NOT be the owner key — the owner key holds forceRefund.
       *
       * ⚠ As deployed on 20 Jul it IS the owner key, so read the sentence above as the intent
       * rather than a description. See the header of pipeline/fulfill.ts.
       */
      workerPrivateKey: hexKey("WORKER_PRIVATE_KEY"),
      /** Derived from the key, never configured separately: the two cannot disagree. */
      workerAddress: privateKeyToAddress(hexKey("WORKER_PRIVATE_KEY")),
    },

    solana: {
      rpcUrl: required("SOLANA_RPC_URL"),
      /** Operator/custody wallet: holds working USDC and the underlying CC NFTs. */
      operatorSecretKey: required("SOLANA_OPERATOR_SECRET_KEY"),
      /** Custody wallet. preflight.mjs asserts the secret key above derives exactly this. */
      /**
       * Branded at the edge, and VALIDATED, not cast.
       *
       * This value goes to Collector Crypt's Solana API and is compared against Solana asset
       * owners. Handing it the EVM operator address broke the first live sell-back and then
       * inverted the custody check. Branding it here means the compiler rejects that swap at
       * every call site instead of at runtime on a money path.
       */
      operatorAddress: asSolanaAddress(
        required("SOLANA_OPERATOR_ADDRESS"),
        "SOLANA_OPERATOR_ADDRESS",
      ),
      usdcMint: optional("USDC_SOLANA_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    },

    deposits: {
      /**
       * Must equal Fulfiller.DEPOSIT_ID_BASE. Deposits borrow MirrorNFT's one-mint-per-order-id
       * guarantee via synthetic ids, and staying above this base is what stops one colliding
       * with a real PackSale order — which would make some future buyer's pack unmintable. The
       * contract re-checks it, so a mismatch fails the transaction rather than costing a buyer.
       */
      idBase: num("DEPOSIT_ID_BASE", 1_000_000),
    },

    token: {
      /** $PWA on Robinhood Chain. Undefined until launch. */
      address: process.env.PONS_TOKEN_ADDRESS as `0x${string}` | undefined,
      /** The fee wallet chosen at launch, where Pons directs the creator's share. */
      feeWallet: process.env.PONS_FEE_WALLET as `0x${string}` | undefined,
    },

    cc: {
      apiUrl: optional("CC_API_URL", "https://gacha.collectorcrypt.com/api"),
      /** Sent as CC's `referrer` cookie. Attribution is not observable from our side. */
      referralCode: process.env.CC_REFERRAL_CODE,
      /** Not enforced by CC today, but the gate can go live at any time. */
      apiKey: process.env.CC_API_KEY,
    },

    bridge: {
      /**
       * deBridge, not Across. Across has no live Solana route (verification-results T4).
       * deBridge is currently the only bridge serving both legs of this loop.
       */
      provider: optional("BRIDGE_PROVIDER", "debridge"),
      apiUrl: optional("DEBRIDGE_API_URL", "https://dln.debridge.finance/v1.0"),
      rhChainId: 4663,
      solanaChainId: 7565164, // deBridge's internal id for Solana
      /**
       * Alert threshold per leg. Fees are near-fixed (~$0.77-1.07 measured), and a spike is
       * the only thing that can make an individual sell-back loss-making — the spread is
       * ~$2.60, so a return leg above that inverts the trade.
       */
      costAlertUsd: num("BRIDGE_COST_ALERT_USD", 2.0),
      /** Refuse to bridge at all above this — a runaway quote must not silently drain gas. */
      costAbortUsd: num("BRIDGE_COST_ABORT_USD", 5.0),
      fillTimeoutMs: num("BRIDGE_FILL_TIMEOUT_MS", 180_000),
    },

    economics: {
      /** Our cut: user gets CC's live rate MINUS this. Never a floor, never hardcoded output. */
      spreadBps: num("SPREAD_BPS", 500),
      /** CC's window is 72h; we stop at 66h to keep a 6h execution buffer. */
      userWindowHours: num("USER_WINDOW_HOURS", 66),
      ccWindowHours: num("CC_WINDOW_HOURS", 72),
      /** 0 unless doc 01 T3 shows the CC buyback right travels with the NFT. */
      unwrapFeeDuringWindowBps: num("UNWRAP_FEE_DURING_WINDOW_BPS", 0),
      quoteTtlSec: num("QUOTE_TTL_SEC", 60),
      quoteDriftRevalidateBps: num("QUOTE_DRIFT_REVALIDATE_BPS", 25),
    },

    /**
     * Master switch for Flow B, default OFF.
     *
     * `sellToCc` runs before the bridge leg, so a half-wired sell-back would sell somebody's
     * physical card and then strand the proceeds — the one state the pipeline exists to
     * prevent. Rather than let it fail partway, the whole path refuses to start until every
     * leg is real: quotes are declined and escrowed mirrors are handed straight back.
     *
     * Turn this on only once the inbound bridge (Solana USDC -> RH USDG) has been proven
     * against the real network.
     */
    sellBackEnabled: process.env.SELL_BACK_ENABLED === "true",

    /**
     * Cards insured above this many WHOLE DOLLARS cannot be sold back or withdrawn.
     *
     * A deliberate ceiling while the high-value paths are proven on cheap cards first. The
     * limit is on the card's stored `insured_value_usd`, read strictly: exactly at the limit
     * is allowed, a cent over is not.
     *
     * Set to 0 to remove the cap entirely. Raising it needs only an env change and a restart,
     * never a code change.
     *
     * Enforced in three places, and the third is the only one that actually holds:
     *   1. the API, so the web path is closed
     *   2. the UI, so nobody clicks a button that will fail
     *   3. the escrow sweeper, which hands a too-valuable mirror straight back
     * A sell-back begins with an on-chain transfer to custody, which no website can prevent,
     * so without (3) this is decoration.
     */
    /**
     * The value ceiling, REQUIRED rather than defaulted.
     *
     * This repository is public, and the threshold at which a sale or withdrawal stops being
     * automatic and starts needing a person is an operational detail — publishing it tells
     * anyone exactly where the manual review line sits. So it lives in the operator's env and
     * nowhere else.
     *
     * Required, not defaulted to 0: 0 means "no ceiling" to `exceedsValueLimit`, so a missing
     * value would silently REMOVE the protection. Failing at boot is the only safe way to be
     * wrong about this.
     */
    maxSellBackValueUsd: Number(required("SELL_BACK_MAX_VALUE_USD")),

    /**
     * The withdraw relayer's kill switch. OFF by default, deliberately.
     *
     * `MirrorNFT.burnForUnwrap` BURNS THE MIRROR and then emits `UnwrapRequested` for us to
     * relay. There is no refund path and no way back: the moment a user calls it they hold
     * nothing and are owed a physical card. So this is must-complete in the same sense as a
     * pack open, except the final step is an irreversible Solana transfer.
     *
     * With this false the relayer still WATCHES and RECORDS every request durably, and alerts.
     * It just does not send. That is the safe failure: a recorded request can be relayed by
     * hand later, whereas an unrecorded one is a user with a burned mirror and no trace.
     */
    withdrawEnabled: process.env.WITHDRAW_ENABLED === "true",

    /**
     * Require a withdraw destination to already exist on chain.
     *
     * No format check can catch a typo, because a mistyped Solana address is usually still a
     * VALID one — they run 32 to 44 characters, so dropping a character yields another
     * perfectly canonical address belonging to nobody. Requiring the account to exist does not
     * prove the user holds its key, but a random typo lands on an unused address essentially
     * always. Costs a new wallet one small SOL transfer before it can receive a card.
     *
     * On by default: the thing being protected is irreplaceable.
     */
    withdrawRequireFundedDestination: process.env.WITHDRAW_REQUIRE_FUNDED_DESTINATION !== "false",

    limits: {
      orderTimeoutMin: num("ORDER_TIMEOUT_MIN", 10),
      maxPackPriceUsdg: num("MAX_PACK_PRICE_USDG", 55),
      /** Doc 06 §6: a second force-refund inside 7 days auto-pauses new packs. */
      forceRefundWindowDays: num("FORCE_REFUND_WINDOW_DAYS", 7),
      forceRefundCountHalt: num("FORCE_REFUND_COUNT_HALT", 2),
      forceRefundRateMinOrders: num("FORCE_REFUND_RATE_MIN_ORDERS", 500),
      forceRefundRateBps: num("FORCE_REFUND_RATE_BPS", 100),
    },

    db: { path: optional("DB_PATH", "./data/gacha.sqlite") },
    api: {
      port: num("API_PORT", 8787),
      corsOrigin: optional("CORS_ORIGIN", "http://localhost:5173"),
      /**
       * Public base URL, baked into tokenURI at mint time and immutable per token.
       *
       * Deliberately the SITE domain, not an api. subdomain. tokenURI outlives everything
       * else: a card minted today must still resolve years from now. A separate hostname is
       * one more DNS record and certificate that has to survive independently, and if it
       * lapses every minted card loses its name and image while the site itself keeps
       * working. Pointing at our own site domain means the metadata dies only if the whole
       * product does, which is the smallest failure surface available without immutable
       * storage.
       *
       * The eventual answer is arweave or IPFS, where nothing has to be kept alive at all.
       * Until then this is one hostname, and it must never change.
       *
       * REQUIRED, with no default, and that is deliberate. This value is baked into
       * tokenURI at mint time and is immutable per token, so a wrong value cannot be
       * corrected later — every card minted under it points somewhere else forever.
       * A default is exactly how that happens: the fallback here used to be another
       * deployment's domain, so an unset variable would have silently served this
       * project's metadata from someone else's server, and only for as long as they
       * chose to keep serving it. Failing to boot is the cheaper outcome.
       */
      publicUrl: required("PUBLIC_API_URL"),
    },
  };

  validate(cfg);
  return cfg;
}

function validate(cfg: {
  economics: { spreadBps: number; userWindowHours: number; ccWindowHours: number };
  bridge: { costAlertUsd: number; costAbortUsd: number };
}) {
  const { economics: e, bridge: b } = cfg;

  if (e.spreadBps < 0 || e.spreadBps > 10_000) {
    throw new Error(`SPREAD_BPS out of range: ${e.spreadBps}`);
  }
  // The 6h buffer is the entire margin for executing a sell against CC before their window
  // shuts. If these ever invert, we would accept sells we cannot fulfil.
  if (e.userWindowHours >= e.ccWindowHours) {
    throw new Error(
      `USER_WINDOW_HOURS (${e.userWindowHours}) must be strictly less than CC_WINDOW_HOURS ` +
        `(${e.ccWindowHours}) — the gap is our execution buffer (doc 00 §2).`,
    );
  }
  if (b.costAbortUsd <= b.costAlertUsd) {
    throw new Error(`BRIDGE_COST_ABORT_USD must exceed BRIDGE_COST_ALERT_USD`);
  }
}
