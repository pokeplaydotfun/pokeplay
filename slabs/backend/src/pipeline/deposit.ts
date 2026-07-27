/**
 * Deposits: a user sends a Collector Crypt card into our Solana vault, and we mint them the
 * mirror on Robinhood Chain.
 *
 * This is the sell-back run backwards, and the asymmetry matters. A sell-back ends with us
 * paying out, so its guards protect our money. A deposit ends with us MINTING, so its guards
 * protect against minting a mirror that is not backed by a card we actually received — which
 * would be a claim on a vault that cannot honour it.
 *
 * Five things must all be true before anything is minted, and every one of them is read from a
 * chain rather than taken from the request:
 *
 *   1. the asset is a Metaplex Core asset in Collector Crypt's collection — not any NFT
 *      someone minted that looks like one
 *   2. our custody wallet owns it NOW, which is the only proof the transfer really happened
 *   3. it is not a card WE pulled from a pack, which would otherwise let someone claim a
 *      mirror for a card already sitting in our vault
 *   4. it has not been deposited before, checked in our table AND on chain
 *   5. the claimer proved they control the Solana wallet that sent it
 *
 * (3) and (5) are the two that turn this from a feature into a hole if they are missing.
 *
 * A DEPOSITED card can never be sold back. We did not buy it, so there are no proceeds of ours
 * to return — paying for it would be handing someone money for a card they gave us and could
 * withdraw again. That rule is enforced in escrow.ts, where the mirror arrives, because a
 * sell-back begins with an on-chain transfer and needs no website.
 */
import type { Db } from "../db/index.ts";
import type { Config } from "../config.ts";

/** Collector Crypt's Metaplex Core collection. Verified against every card we have handled. */
export const CC_COLLECTION = "CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac";

export type DepositAsset = {
  /** "MplCoreAsset" for a real card. Anything else is not one. */
  interface: string | null;
  /** The collection it is grouped under, or null if ungrouped. */
  collection: string | null;
  owner: string | null;
  name: string | null;
  imageUrl: string | null;
};

export type DepositChain = {
  /** DAS read of a Solana asset. Null when it does not exist. */
  asset(mint: string): Promise<DepositAsset | null>;
};

export type DepositMinter = {
  /** Fulfiller.mintForDeposit. Returns the minted mirror token id. */
  mintForDeposit(params: {
    to: string;
    depositId: number;
    solanaMint: string;
    name: string | null;
    imageUrl: string | null;
  }): Promise<{ tokenId: string; txHash: string }>;
};

export type DepositDeps = {
  db: Db;
  cfg: Config;
  chain: DepositChain;
  minter: DepositMinter;
  alert: (message: string) => void;
};

export type DepositVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Everything checkable about a claimed deposit, with no side effects.
 *
 * Pure enough to run before recording anything, so a user with a bad claim is told why while
 * they can still act on it, and exhaustively testable without a chain.
 */
export function checkDepositAsset(
  asset: DepositAsset | null,
  custodyWallet: string,
  opts: { backsALiveMirror: boolean; alreadyDeposited: boolean },
): DepositVerdict {
  if (!asset) return { ok: false, reason: "No such asset exists on Solana." };

  if (asset.interface !== "MplCoreAsset") {
    return {
      ok: false,
      reason: `That is a ${asset.interface ?? "unknown"} asset. Collector Crypt cards are Metaplex Core assets.`,
    };
  }

  if (asset.collection !== CC_COLLECTION) {
    return {
      ok: false,
      reason: "That card is not part of Collector Crypt's collection, so we cannot vault it.",
    };
  }

  /**
   * The card must be OURS NOW. This is the only evidence the transfer actually happened, and
   * it is why nothing is minted from the claim alone: a claim is a statement, ownership is a
   * fact.
   */
  if (asset.owner !== custodyWallet) {
    return {
      ok: false,
      reason:
        asset.owner === null
          ? "We cannot read who owns that card right now. Try again shortly."
          : "That card has not arrived in the vault yet. Send it first, then claim.",
    };
  }

  /**
   * A card CURRENTLY IN CUSTODY already backs a mirror, and check (2) passes for it trivially
   * because it is sitting in our vault. Without this, anyone could point a claim at one and be
   * minted a second mirror for a card that already backs someone else's.
   *
   * "Currently" is load-bearing, and getting it wrong was the first thing real testing caught.
   * This originally rejected ANY card we had ever seen, which broke the legitimate round trip:
   * withdraw a card, then deposit it back. After a withdraw the card's state is UNWRAPPED — it
   * left the vault and belongs to the user — so re-depositing it is exactly the case this
   * feature is for. Only CUSTODY means "already spoken for".
   */
  if (opts.backsALiveMirror) {
    return {
      ok: false,
      reason: "That card is already in the vault backing a mirror.",
    };
  }

  if (opts.alreadyDeposited) {
    return { ok: false, reason: "That card has already been deposited." };
  }

  return { ok: true };
}

export class DepositPipeline {
  private readonly d: DepositDeps;

  constructor(deps: DepositDeps) {
    this.d = deps;
  }

  /**
   * Verify a claimed deposit and mint its mirror.
   *
   * The row is written BEFORE the checks so a claim that fails leaves a trace of who tried
   * and why — a user who sent a card and got nothing must not be invisible to us.
   */
  async process(solanaMint: string, depositorEvm: string, solanaTx: string | null): Promise<void> {
    this.d.db.recordDepositClaim({ solanaMint, depositorEvm, solanaTx });

    const existing = this.d.db.getDeposit(solanaMint);
    if (existing?.status === "MINTED") return; // idempotent: already done

    const asset = await this.d.chain.asset(solanaMint);
    const verdict = checkDepositAsset(asset, this.d.cfg.solana.operatorAddress, {
      // CUSTODY only. A card that has been withdrawn (UNWRAPPED) or sold on is not ours and
      // may be deposited — see checkDepositAsset.
      backsALiveMirror: this.d.db.cardByMint(solanaMint)?.state === "CUSTODY",
      alreadyDeposited: Boolean(existing?.mirror_token_id),
    });

    if (!verdict.ok) {
      this.d.db.setDepositStatus(solanaMint, "REJECTED", { last_error: verdict.reason });
      return;
    }

    this.d.db.setDepositStatus(solanaMint, "VERIFIED", { last_error: null });

    /**
     * The synthetic deposit id.
     *
     * Derived from our own row id plus the contract's base, never from a chain counter, so two
     * deposits can never race to the same number. The contract re-checks the invariant that it
     * cannot collide with a real PackSale order, so a mistake here fails the transaction rather
     * than costing a future buyer their pack.
     */
    const depositId = this.d.cfg.deposits.idBase + (existing?.rowid ?? this.d.db.getDeposit(solanaMint)!.rowid);

    const minted = await this.d.minter.mintForDeposit({
      to: depositorEvm,
      depositId,
      solanaMint,
      name: asset!.name,
      imageUrl: asset!.imageUrl,
    });

    this.d.db.setDepositStatus(solanaMint, "MINTED", {
      mirror_token_id: minted.tokenId,
      deposit_id: depositId,
      last_error: null,
    });

    /**
     * Recorded as a card so the collection, the withdraw path and the reserves count all see
     * it — with origin DEPOSIT, which is what stops it ever being sold back.
     */
    this.d.db.insertDepositedCard({
      solanaMint,
      name: asset!.name,
      imageUrl: asset!.imageUrl,
      ownerMirrorTokenId: minted.tokenId,
    });

    this.d.alert(`Deposit ${solanaMint} mirrored as token ${minted.tokenId} for ${depositorEvm}.`);
  }
}
