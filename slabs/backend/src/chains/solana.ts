/**
 * Solana side: the operator wallet that buys packs and custodies the cards.
 *
 * This wallet is unavoidably hot, because the worker has to sign pack purchases without a
 * human present. It also ends up holding every custodied card, which is the largest
 * concentration of value in the system. Nothing here can fix that tension; what it can do is
 * refuse to act when the preconditions are not met, so a failure is a clean stop rather than
 * a half-completed purchase.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import bs58 from "bs58";
import type { Config } from "../config.ts";
import {
  checkDestinationFormat,
  checkDestinationAccount,
  type AccountSnapshot,
} from "./solana-destination.ts";
import { asSolanaAddress, type SolanaAddress } from "./address.ts";

/** Accepts either solana-keygen's JSON array or a base58 export from a wallet UI. */
export function loadKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed) as number[]));
  }
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const ch of trimmed) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("SOLANA_OPERATOR_SECRET_KEY is neither a JSON array nor base58");
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  const pad = trimmed.length - trimmed.replace(/^1+/, "").length;
  return Keypair.fromSecretKey(Uint8Array.from([...new Uint8Array(pad), ...body]));
}

/**
 * Below this the wallet cannot reliably pay for a bridge back (0.015 SOL fixed fee) plus
 * transaction fees. The pipeline stops rather than stranding a sell-back halfway.
 */
export const MIN_SOL_LAMPORTS = 0.03 * LAMPORTS_PER_SOL;

/**
 * base58 of 32 zero bytes: what a transaction builder leaves in `recentBlockhash` when it
 * expects the client to fill one in. deBridge does exactly this.
 */
export const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111";

/** One asset as the DAS `getAssetsByOwner` / `getAsset` endpoints return it. */
type DasAsset = {
  id: string;
  interface?: string;
  grouping?: { group_key?: string; group_value?: string }[];
  content?: {
    metadata?: { name?: string };
    links?: { image?: string };
    files?: { uri?: string }[];
  };
};

export class SolanaChain {
  readonly connection: Connection;
  readonly keypair: Keypair;
  /** Our custody wallet. Branded: it comes from a keypair, so it is a Solana address by
      construction, and the brand stops it being swapped for the EVM operator downstream. */
  readonly address: SolanaAddress;
  private readonly usdcMint: PublicKey;

  constructor(cfg: Config) {
    this.connection = new Connection(cfg.solana.rpcUrl, "confirmed");
    this.keypair = loadKeypair(cfg.solana.operatorSecretKey);
    this.address = asSolanaAddress(this.keypair.publicKey.toBase58(), "custody wallet");
    this.usdcMint = new PublicKey(cfg.solana.usdcMint);

    // The configured address and the key must agree. If they do not, every purchase would be
    // made from a wallet we did not intend and the cards would land somewhere else.
    if (this.address !== cfg.solana.operatorAddress) {
      throw new Error(
        `SOLANA_OPERATOR_SECRET_KEY controls ${this.address} but SOLANA_OPERATOR_ADDRESS is ` +
          `${cfg.solana.operatorAddress}. Refusing to start.`,
      );
    }
  }

  async solBalance(): Promise<number> {
    return this.connection.getBalance(this.keypair.publicKey);
  }

  /** USDC base units held by the operator. Zero if the token account does not exist yet. */
  /**
   * USDC in our custody. A MISSING ACCOUNT is genuinely zero; an unreadable one is not.
   *
   * This used to `catch { return 0n }` for both. The direction was safe — the funds gate
   * blocks a draw either way — but the message was a lie: the operator was told "the bridged
   * funds would not cover the pack", naming a shortfall that did not exist, when the real
   * fault was a dead RPC. That sends someone to top up a wallet that is already funded.
   *
   * TokenAccountNotFoundError means the ATA has never been created, which really is a zero
   * balance. Anything else is rethrown so the caller reports the actual fault.
   */
  async usdcBalance(): Promise<bigint> {
    const ata = await getAssociatedTokenAddress(this.usdcMint, this.keypair.publicKey);
    try {
      const account = await getAccount(this.connection, ata);
      return account.amount;
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TokenAccountNotFoundError" || name === "TokenInvalidAccountOwnerError") {
        return 0n;
      }
      throw new Error(
        `Cannot read the custody USDC balance (${ata.toBase58()}): ` +
          `${err instanceof Error ? err.message : String(err)}. This is NOT a zero balance.`,
      );
    }
  }

  /**
   * Sign an already-built transaction and submit it.
   *
   * Used for both the CC pack purchase (which arrives co-signed by CC's gacha authority) and
   * the deBridge return leg. `partialSign` semantics matter enormously for the first case:
   * CC's signature is already in the array and replacing it would invalidate the whole
   * transaction. VersionedTransaction.sign appends rather than replaces, which is correct.
   */
  async signAndSend(encodedTx: string, onSent?: (signature: string) => void): Promise<string> {
    const raw = decodeSolanaTx(encodedTx);
    const tx = VersionedTransaction.deserialize(raw);
    assertTransactionIsSafeToSign(tx, this.keypair.publicKey.toBase58());

    /**
     * Fill in a real blockhash, but ONLY when the builder left a placeholder.
     *
     * deBridge's create-tx returns the transaction unsigned with an all-zero blockhash
     * (`11111111111111111111111111111111`) and expects the client to supply a fresh one.
     * Signing it as-is fails simulation with "Blockhash not found", which is what the first
     * real inbound bridge attempt hit.
     *
     * The condition is load-bearing. CC's pack transactions arrive ALREADY CO-SIGNED by their
     * gacha authority against a real blockhash. Overwriting it there would invalidate CC's
     * signature and break every pack purchase, converting a working buy path into a broken
     * one to fix a bridge that is not even switched on. So a real blockhash is always left
     * exactly as the builder set it.
     */
    let blockhash = tx.message.recentBlockhash;
    let lastValidBlockHeight: number | undefined;
    if (blockhash === PLACEHOLDER_BLOCKHASH) {
      const latest = await this.connection.getLatestBlockhash("confirmed");
      blockhash = latest.blockhash;
      lastValidBlockHeight = latest.lastValidBlockHeight;
      tx.message.recentBlockhash = blockhash;
    }

    tx.sign([this.keypair]);

    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    // Broadcast. The funds may already be gone, so the caller must be able to record that
    // before the confirmation wait below, which can time out on a landed transaction.
    onSent?.(signature);

    // Confirm against the blockhash this transaction actually carries. Fetching a fresh one
    // here would set an expiry unrelated to the transaction being confirmed.
    const height =
      lastValidBlockHeight ?? (await this.connection.getLatestBlockhash("confirmed")).lastValidBlockHeight;
    const result = await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight: height },
      "confirmed",
    );
    if (result.value.err) {
      throw new Error(`Solana transaction ${signature} failed: ${JSON.stringify(result.value.err)}`);
    }
    return signature;
  }

  /**
   * Send a custodied card to its owner's Solana wallet. THIS IS IRREVERSIBLE.
   *
   * Collector Crypt's cards are Metaplex Core assets, not SPL token NFTs, so this uses
   * mpl-core's transferV1. `@solana/spl-token` cannot move them at all.
   *
   * The transaction is BUILT HERE, by us, from a mint and a destination we chose. That is the
   * whole reason it is allowed to touch MPL Core while `assertTransactionIsSafeToSign`
   * refuses any third-party blob that does: the guard exists to stop Collector Crypt or
   * deBridge handing us a card-stealing transaction, and a transfer we construct ourselves is
   * not that. Never route an externally supplied transaction through this path.
   *
   * Refuses to send anywhere except a valid ed25519 address, and refuses to send a card we do
   * not hold — the second check is cheap and the mistake it prevents is permanent.
   */
  async withdrawAssetTo(
    mint: string,
    destination: string,
    opts: { dryRun?: boolean; requireDestinationExists?: boolean } = {},
  ): Promise<{ signature: string | null; dryRun: boolean; destination: string }> {
    // 1. FORMAT. Pure, no network. Rejects the System Program, burn addresses, program ids
    //    and PDAs. See solana-destination.ts for why isOnCurve alone is not this check.
    const format = checkDestinationFormat(destination);
    if (!format.ok) throw new Error(`Refusing to withdraw ${mint}: ${format.reason}`);
    const dest = format.address;

    if (dest === this.address) {
      throw new Error(`Refusing to withdraw ${mint}: the destination is our own custody wallet.`);
    }

    // 2. THE DESTINATION ACCOUNT. Catches an executable program, or a program-owned account,
    //    that the denylist does not name. Optionally requires the address to have been used
    //    before, which is the only real defence against a typo that is still a valid address.
    const snapshot = await this.accountSnapshot(dest);
    const account = checkDestinationAccount(dest, snapshot, opts.requireDestinationExists ?? false);
    if (!account.ok) throw new Error(`Refusing to withdraw ${mint}: ${account.reason}`);

    // 3. WE MUST HOLD IT. Cheap, and the mistake it prevents is permanent.
    const owner = await this.assetOwner(mint);
    if (owner !== this.address) {
      throw new Error(
        `Refusing to withdraw ${mint}: it is owned by ${owner ?? "unknown"}, not our custody ` +
          `wallet. Either it already left or we never held it.`,
      );
    }

    const { createUmi } = await import("@metaplex-foundation/umi-bundle-defaults");
    const { transferV1, fetchAsset } = await import("@metaplex-foundation/mpl-core");
    const { keypairIdentity, publicKey } = await import("@metaplex-foundation/umi");

    // Build the umi signer through umi's own eddsa helper rather than hand-shaping an object.
    // A cast-shaped keypair typechecks and then fails at signing time, which on this path
    // means discovering it after a user has already burned their mirror.
    const umi = createUmi(this.connection.rpcEndpoint);
    umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(this.keypair.secretKey)));

    // Fetching the asset is a READ. Doing it before the dry-run exit means a dry run still
    // proves the asset resolves and the collection is readable — the parts most likely to be
    // wrong — rather than only re-checking the address.
    const asset = await fetchAsset(umi, publicKey(mint));

    /**
     * THE LAST EXIT. Everything above is a read; everything below is irreversible.
     *
     * A card was destroyed by running the real transfer to test a rejection path. This branch
     * is how that is tested instead.
     */
    if (opts.dryRun) return { signature: null, dryRun: true, destination: dest };

    const res = await transferV1(umi, {
      asset: asset.publicKey,
      newOwner: publicKey(dest),
      collection: asset.updateAuthority?.type === "Collection" ? asset.updateAuthority.address : undefined,
    }).sendAndConfirm(umi);

    return { signature: bs58.encode(res.signature), dryRun: false, destination: dest };
  }

  /** Enough of an account for `checkDestinationAccount`. Absent accounts are normal. */
  async accountSnapshot(address: string): Promise<AccountSnapshot> {
    const info = await this.connection.getAccountInfo(new PublicKey(address));
    if (!info) return { exists: false, executable: false, owner: null };
    return { exists: true, executable: info.executable, owner: info.owner.toBase58() };
  }

  /**
   * Who currently owns a card on Solana. Null when the state cannot be read.
   *
   * This is the authority for "did Collector Crypt actually take the card?". A sell-back
   * submits over HTTP, and an HTTP call that loses its response leaves us unable to tell
   * locally whether CC processed it. The chain can tell us: if the asset has left our custody
   * wallet, the sale happened, whatever our own tables say.
   */
  /**
   * Everything a deposit needs to know about an asset, in ONE read.
   *
   * Interface, collection and owner all come from the same DAS response, so they describe the
   * same instant. Fetching them separately would let a card change hands between the ownership
   * check and the collection check — a small window, but the whole point of these checks is
   * that nothing is taken on trust.
   */
  async depositAsset(mint: string): Promise<{
    interface: string | null;
    collection: string | null;
    owner: string | null;
    name: string | null;
    imageUrl: string | null;
  } | null> {
    try {
      const res = await fetch(this.connection.rpcEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: mint } }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as {
        result?: {
          interface?: string;
          ownership?: { owner?: string };
          grouping?: { group_key?: string; group_value?: string }[];
          content?: { metadata?: { name?: string }; links?: { image?: string }; files?: { uri?: string }[] };
        };
      };
      const r = body.result;
      if (!r) return null;

      const collection =
        (r.grouping ?? []).find((g) => g.group_key === "collection")?.group_value ?? null;

      return {
        interface: r.interface ?? null,
        collection,
        owner: r.ownership?.owner ?? null,
        name: r.content?.metadata?.name ?? null,
        imageUrl: r.content?.links?.image ?? r.content?.files?.[0]?.uri ?? null,
      };
    } catch {
      // Null owner is treated as "cannot verify" by checkDepositAsset, never as "arrived".
      return null;
    }
  }

  /**
   * One page of getAssetsByOwner. THROWS, with a message safe to show a stranger.
   *
   * Every failure mode is separated out because they used to be indistinguishable: a transport
   * error, an HTTP 429 and a JSON-RPC error all ended up as "no items", which the caller could
   * not tell apart from an empty wallet.
   *
   * ⚠ The raw error is deliberately NOT interpolated into the thrown message. This RPC endpoint
   * carries the provider API key in its URL, and the message travels to an unauthenticated
   * caller via /deposit/cards. Detail goes to the log; the caller gets the shape of the failure.
   */
  private async assetsByOwnerPage(owner: string, page: number, limit: number): Promise<DasAsset[]> {
    let res: Response;
    try {
      res = await fetch(this.connection.rpcEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAssetsByOwner",
          params: { ownerAddress: owner, page, limit },
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      console.error(`getAssetsByOwner(page ${page}) transport failure:`, err);
      throw new Error("the Solana RPC did not respond");
    }

    if (!res.ok) {
      console.error(`getAssetsByOwner(page ${page}) HTTP ${res.status}`);
      throw new Error(
        res.status === 429
          ? "the Solana RPC is rate limiting us — try again in a moment"
          : `the Solana RPC returned HTTP ${res.status}`,
      );
    }

    let body: { result?: { items?: DasAsset[] }; error?: { code?: number; message?: string } };
    try {
      body = (await res.json()) as typeof body;
    } catch (err) {
      console.error(`getAssetsByOwner(page ${page}) unparseable response:`, err);
      throw new Error("the Solana RPC returned a malformed response");
    }

    if (body.error) {
      console.error(`getAssetsByOwner(page ${page}) JSON-RPC error:`, body.error);
      throw new Error("the Solana RPC rejected the request");
    }
    if (!body.result) {
      console.error(`getAssetsByOwner(page ${page}) returned no result field`);
      throw new Error("the Solana RPC returned no result");
    }
    return body.result.items ?? [];
  }

  /**
   * Every Collector Crypt card a wallet owns, for the deposit picker.
   *
   * Filtered by collection HERE rather than in the browser: the same grouping that authorises a
   * deposit decides what we offer, so the list a user picks from cannot contain something the
   * verifier would later refuse.
   *
   * ⚠ THROWS on failure — it does not return an empty list. Swallowing errors was once described
   * here as the honest option; it is the opposite. `[]` is a positive claim that the wallet holds
   * no cards, so a rate-limited or timed-out lookup rendered "No Collector Crypt cards in that
   * wallet" over a wallet full of them, with no error and nothing to retry. An empty array now
   * means exactly one thing, and the caller turns a throw into a 502 the page can show.
   *
   * Paged to exhaustion for the same reason: a single page of 1000 silently dropped anything
   * beyond it, which is precisely the "partial list presented as complete" this comment used to
   * warn against. If even the page cap is exceeded we throw rather than return a truncated list.
   */
  async collectorCryptCardsOf(owner: string, collection: string): Promise<
    { mint: string; name: string | null; imageUrl: string | null }[]
  > {
    const PAGE_SIZE = 1000;
    /** 20k assets in one wallet is far past any real holder; beyond it, refuse rather than lie. */
    const MAX_PAGES = 20;
    const out: { mint: string; name: string | null; imageUrl: string | null }[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = await this.assetsByOwnerPage(owner, page, PAGE_SIZE);

      for (const a of items) {
        if (a.interface !== "MplCoreAsset") continue;
        const inCollection = (a.grouping ?? []).some(
          (g) => g.group_key === "collection" && g.group_value === collection,
        );
        if (!inCollection) continue;
        out.push({
          mint: a.id,
          name: a.content?.metadata?.name ?? null,
          imageUrl: a.content?.links?.image ?? a.content?.files?.[0]?.uri ?? null,
        });
      }

      // A short page is the last page. An exactly-full one means there may be more.
      if (items.length < PAGE_SIZE) return out;
    }

    console.error(`getAssetsByOwner: ${owner} exceeded ${MAX_PAGES} pages`);
    throw new Error("that wallet holds too many assets to list");
  }

  /**
   * Build the UNSIGNED transfer that moves a card into the vault, for the depositor to sign.
   *
   * Built here rather than in the browser so the site does not ship Metaplex's libraries to
   * every visitor. The trade is that the depositor signs a transaction we constructed — so it
   * is deliberately minimal: ONE transferV1 instruction, their card, our vault, no extras. Any
   * wallet worth using previews exactly that before signing, and the deposit page shows the
   * vault address beside it so the two can be compared.
   *
   * The fee payer is the DEPOSITOR. We are not a signer on this transaction at all, which is
   * what makes it safe for us to build: we cannot add anything that spends from us, and they
   * cannot be made to authorise anything they are not shown.
   */
  async buildDepositTransfer(mint: string, owner: string): Promise<string> {
    const { createUmi } = await import("@metaplex-foundation/umi-bundle-defaults");
    const { transferV1, fetchAsset } = await import("@metaplex-foundation/mpl-core");
    const { publicKey, createNoopSigner, signerIdentity } = await import("@metaplex-foundation/umi");

    const umi = createUmi(this.connection.rpcEndpoint);
    // A noop signer for the OWNER: it contributes the public key and no signature, which is
    // precisely what an unsigned transaction for them to sign needs.
    umi.use(signerIdentity(createNoopSigner(publicKey(owner))));

    const asset = await fetchAsset(umi, publicKey(mint));

    const builder = transferV1(umi, {
      asset: asset.publicKey,
      newOwner: publicKey(this.address),
      collection: asset.updateAuthority?.type === "Collection" ? asset.updateAuthority.address : undefined,
    });

    const withBlockhash = await builder.setLatestBlockhash(umi);
    const built = withBlockhash.build(umi);
    return Buffer.from(umi.transactions.serialize(built)).toString("base64");
  }

  async assetOwner(mint: string): Promise<string | null> {
    try {
      const res = await fetch(this.connection.rpcEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: mint } }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as { result?: { ownership?: { owner?: string } } };
      return body.result?.ownership?.owner ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Is this card frozen, and therefore impossible to move?
   *
   * Collector Crypt's cards are Metaplex Core (MPL Core) assets, NOT SPL token NFTs, and many
   * carry a `permanent_freeze_delegate` plugin whose authority is a third party. A frozen
   * asset cannot be transferred by anyone, including us.
   *
   * That matters because custody is the whole product: a mirror is a claim on a specific card
   * we hold. If that card is frozen we cannot deliver it on withdraw and cannot sell it back
   * to CC, so the mirror would be a promise we cannot keep.
   *
   * Sampled 19 Jul 2026: 8 of 12 pokemon_50 pool cards and 3 of 12 pokemon_250 cards were
   * frozen while sitting in CC's pool. It is NOT yet known whether that clears on purchase
   * (plausible: frozen while staked) or persists into our custody. The first real open
   * answers it, which is why this is called and alerted on rather than assumed either way.
   *
   * Returns null when the state cannot be read, so a DAS outage never looks like "fine".
   */
  async assetFrozen(mint: string): Promise<boolean | null> {
    try {
      const res = await fetch(this.connection.rpcEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: mint } }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as { result?: { ownership?: { frozen?: boolean } } };
      const frozen = body.result?.ownership?.frozen;
      return typeof frozen === "boolean" ? frozen : null;
    } catch {
      return null;
    }
  }

  /**
   * Everything that must be true before the wallet can take part in a pack open. Returned
   * rather than thrown so the caller can surface it as "unavailable" instead of an error.
   */
  async readiness(): Promise<{ ok: boolean; reasons: string[]; solLamports: number; usdc: bigint }> {
    const reasons: string[] = [];
    const [solLamports, usdc] = await Promise.all([this.solBalance(), this.usdcBalance()]);

    if (solLamports < MIN_SOL_LAMPORTS) {
      reasons.push(
        `SOL balance ${(solLamports / LAMPORTS_PER_SOL).toFixed(4)} is below the ` +
          `${(MIN_SOL_LAMPORTS / LAMPORTS_PER_SOL).toFixed(3)} needed for fees and a return bridge`,
      );
    }
    return { ok: reasons.length === 0, reasons, solLamports, usdc };
  }
}

/**
 * Decode a serialised Solana transaction that may arrive as hex OR base64.
 *
 * This existed as a bare `Buffer.from(str, "base64")`, and it was wrong for the only caller
 * that matters. deBridge's `create-tx` returns the Solana-side transaction as a 0x-prefixed
 * HEX string, not base64. Buffer.from silently ignores characters it cannot decode rather
 * than throwing, so a 1768-char hex string decoded to 1326 bytes of garbage instead of the
 * real 883, and VersionedTransaction.deserialize failed with "Reached end of buffer
 * unexpectedly".
 *
 * Why it mattered: this is the sell-back payout path. `sellToCc` runs BEFORE the bridge, so
 * the failure landed AFTER the seller's card had already been sold to Collector Crypt — the
 * card gone, the seller unpaid, and the fault deterministic, so every retry failed the same
 * way forever. That is the exact state SELL_BACK_ENABLED exists to prevent, and it would have
 * appeared on the first real sell-back.
 *
 * Found 19 Jul 2026 by proving the inbound bridge leg with operator float. Cost to find: $0,
 * because the decode fails before anything is broadcast. Cost to find via a real sell-back:
 * somebody's card.
 *
 * Both encodings are accepted rather than just swapping to hex: CC's own pack transactions
 * are genuinely base64, and a decoder that quietly mangles the wrong format is what caused
 * this in the first place.
 */
export function decodeSolanaTx(encoded: string): Buffer {
  const trimmed = encoded.trim();
  if (/^0x[0-9a-fA-F]*$/.test(trimmed)) {
    return Buffer.from(trimmed.slice(2), "hex");
  }
  // Unprefixed hex is still hex: an even-length string of only hex digits cannot be a
  // meaningful base64 transaction, and guessing base64 here is the original bug.
  if (trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length > 64) {
    return Buffer.from(trimmed, "hex");
  }
  return Buffer.from(trimmed, "base64");
}


/**
 * Programs this wallet is willing to invoke when signing a transaction it did not build.
 *
 * Everything here is either infrastructure (compute budget, system, ATA) or a program we
 * deliberately transact with (SPL Token for USDC, deBridge for the bridge legs).
 *
 * Notably ABSENT: **MPL Core** (`CoREENxT…hX7d`), which is the standard Collector Crypt's
 * cards actually use. Nothing we sign should ever move a custodied card, so a transaction
 * that touches MPL Core is exactly the transaction we must refuse.
 */
const ALLOWED_PROGRAMS = new Set([
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111", // System
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account
  // Memo. Collector Crypt writes the order memo with it, and that memo IS our binding between
  // an on-chain order and the pack CC opened — the proof endpoint and the reveal both key on
  // it. Verified against a real generatePack response: without this the allowlist rejects
  // every pack purchase. It only writes a note and moves nothing.
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4", // deBridge DLN source
  "dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo", // deBridge DLN destination
  "DEbrdGj3HsRsAzx6uH4MKyREKxVAfBydijLUF3ygsFfh", // deBridge
]);

/**
 * Refuse to sign a transaction that does something we did not ask for.
 *
 * The worker signs blobs handed to it over HTTPS by Collector Crypt and deBridge, unattended,
 * with a key that also custodies every card we hold. Nothing inspected those blobs: a
 * compromised or impersonated upstream could return a transaction that sweeps the USDC
 * account and every MPL Core asset in the wallet, and the worker would sign it.
 *
 * TLS was the only control. This adds a second one that does not depend on the upstream being
 * honest — the same reasoning behind not trusting a price feed or a quote.
 *
 * Two checks, both cheap and both hard to argue with:
 *
 *   1. every program invoked must be on the allowlist, which excludes MPL Core entirely, so
 *      no transaction we sign can move a custodied card
 *   2. we must be the fee payer, so we cannot be made a silent co-signer on somebody else's
 *      transaction
 *
 * This is NOT full instruction-level validation — it does not check amounts or destinations,
 * so a malicious deBridge could still misdirect a bridge transfer. It removes the largest and
 * most irreversible class (card theft) rather than every class, and should not be mistaken
 * for the complete answer.
 */

/**
 * Collector Crypt's gacha authority: the wallet that BUILDS and pays for a buyback.
 *
 * Observed on a real `/buyback` build for our own card on 21 Jul 2026, and it is the fee payer
 * on every one. Overridable by env so it is not a magic constant nobody can rotate, but it is
 * a fixed allowlist entry either way — never "whoever happens to be paying".
 */
export const CC_GACHA_AUTHORITY =
  process.env.CC_GACHA_AUTHORITY ?? "GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3";

/** MPL Core, the standard Collector Crypt's cards use. */
const MPL_CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";

/**
 * The guard for a SELL-BACK transaction, which `assertTransactionIsSafeToSign` must reject.
 *
 * That guard is right for everything it covers: it refuses any third-party transaction whose
 * fee payer is not us, and refuses MPL Core outright, because nothing we sign should move a
 * custodied card. A buyback breaks BOTH rules by design — Collector Crypt builds it, pays the
 * fee, and it moves our card, which is the entire point of selling. So the sell-back could
 * never have signed, and widening the general guard to let it through would have removed the
 * protection from the pack-purchase path too, where it is exactly right.
 *
 * This is the narrow exception, and it is stricter than the general rule in the way that
 * matters: the card being moved must be THE card we chose to sell.
 *
 *   - the fee payer must be CC's known authority, not merely "not us"
 *   - exactly ONE MPL Core instruction may appear, and no more
 *   - that instruction must reference `expectedMint`, so CC cannot substitute another of our
 *     cards, which is the actual attack the MPL Core ban was written to stop
 *   - every other program must still be on the general allowlist
 */
export function assertBuybackTransactionIsSafeToSign(
  tx: VersionedTransaction,
  ourWallet: string,
  expectedMint: string,
): void {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());

  const feePayer = keys[0];
  if (feePayer !== CC_GACHA_AUTHORITY && feePayer !== ourWallet) {
    throw new Error(
      `Refusing to sign buyback: fee payer is ${feePayer}, which is neither this wallet nor ` +
        `Collector Crypt's known authority (${CC_GACHA_AUTHORITY}).`,
    );
  }

  if (!keys.includes(ourWallet)) {
    throw new Error(`Refusing to sign buyback: our wallet ${ourWallet} is not referenced at all.`);
  }

  const coreInstructions = tx.message.compiledInstructions.filter(
    (ix) => keys[ix.programIdIndex] === MPL_CORE,
  );

  if (coreInstructions.length !== 1) {
    throw new Error(
      `Refusing to sign buyback: expected exactly one MPL Core instruction, found ` +
        `${coreInstructions.length}. More than one card could be moving.`,
    );
  }

  const movedAccounts = coreInstructions[0]!.accountKeyIndexes.map((i) => keys[i]);
  if (!movedAccounts.includes(expectedMint)) {
    throw new Error(
      `Refusing to sign buyback: the card instruction does not reference ${expectedMint}. ` +
        `Collector Crypt may be trying to move a different card of ours.`,
    );
  }

  for (const ix of tx.message.compiledInstructions) {
    const programId = keys[ix.programIdIndex];
    if (!programId) {
      throw new Error("Refusing to sign buyback: an instruction references an unknown program.");
    }
    if (programId === MPL_CORE) continue; // already validated, and only one exists
    if (!ALLOWED_PROGRAMS.has(programId)) {
      throw new Error(
        `Refusing to sign buyback: transaction invokes ${programId}, which is not on the ` +
          `allowlist. Never widen this to make an error go away.`,
      );
    }
  }
}

export function assertTransactionIsSafeToSign(tx: VersionedTransaction, expectedFeePayer: string): void {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());

  const feePayer = keys[0];
  if (feePayer !== expectedFeePayer) {
    throw new Error(
      `Refusing to sign: fee payer is ${feePayer}, not this wallet (${expectedFeePayer}). ` +
        `We must never be a silent co-signer on somebody else's transaction.`,
    );
  }

  for (const ix of tx.message.compiledInstructions) {
    const programId = keys[ix.programIdIndex];
    if (!programId) {
      throw new Error("Refusing to sign: a transaction instruction references an unknown program.");
    }
    if (!ALLOWED_PROGRAMS.has(programId)) {
      throw new Error(
        `Refusing to sign: transaction invokes ${programId}, which is not on the allowlist. ` +
          `If this is a legitimate new program, add it deliberately — never widen this to make ` +
          `an error go away.`,
      );
    }
  }
}

