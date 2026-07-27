/**
 * Robinhood Chain: watching for orders and minting the mirror against them.
 *
 * Two responsibilities, deliberately kept apart:
 *
 *   RhOrderWatcher  reads OrderCreated and hands the pipeline work to do
 *   RhMirrorMinter  writes the result back through the Fulfiller
 *
 * The write path goes through Fulfiller.fulfill and never touches MirrorNFT.mint or
 * PackSale.markFulfilled directly. That is the whole point of the Fulfiller: mint and
 * escrow-release are one atomic call, so a crash between them cannot leave a card minted
 * with the buyer's money still trapped, or the money released with no card.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  stringToHex,
  hexToString,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import bs58 from "bs58";
import type { Config } from "../config.ts";

/**
 * Machine id encoding. THIS MUST MATCH THE FRONTEND EXACTLY.
 *
 * frontend/src/useBuyPack.ts uses `stringToHex(code, { size: 32 })`, which is right-padded
 * ASCII, NOT keccak256. The contract test suite happens to use keccak hashes for its own
 * fixtures, so the two look interchangeable until you call setMachine with the wrong one and
 * every single buy reverts with MachineDisabled.
 *
 * There is no on-chain way to detect the mismatch: PackSale only ever sees bytes32. The only
 * defence is that both sides derive it the same way, so this function and the frontend's are
 * the same one line, and `assertMachineIdMatches` re-checks a round trip at startup.
 */
export function machineIdToBytes32(code: string): Hex {
  if (code.length > 32) throw new Error(`machine id "${code}" exceeds 32 bytes`);
  return stringToHex(code, { size: 32 });
}

/** Inverse, for turning an on-chain id back into a CC machine code. */
export function bytes32ToMachineId(raw: Hex): string {
  // Trailing NULs are padding, not data.
  return hexToString(raw, { size: 32 }).replace(/\0+$/, "");
}

/** Round-trip guard, run at startup so an encoding change fails loudly and immediately. */
export function assertMachineIdRoundTrip(codes: string[]): void {
  for (const code of codes) {
    const back = bytes32ToMachineId(machineIdToBytes32(code));
    if (back !== code) {
      throw new Error(`machine id encoding is broken: "${code}" round-tripped to "${back}"`);
    }
  }
}

export const PACK_SALE_ABI = parseAbi([
  "event OrderCreated(uint256 indexed orderId, address indexed buyer, bytes32 indexed machineId, uint256 price, uint64 deadline, bool turbo)",
  "event OrderFulfilled(uint256 indexed orderId, uint256 mirrorTokenId, bytes32 ccTxSigHash)",
  "event OrderRefunded(uint256 indexed orderId, address indexed buyer, uint256 price)",
  // Verified against the deployed source, not guessed: Order carries a `deadline` between
  // createdAt and status, and there is no machinePrice/machineEnabled pair, only the public
  // `machines` mapping. Getting either wrong decodes silently into the wrong field.
  /**
   * All EIGHT fields. The struct gained `drawn` and `turbo`; declaring six happened to decode
   * correctly because viem ignores trailing static words, but it is silently fragile — a field
   * inserted before `status` would shift the decode, and `status` is what assertSpendable
   * gates every spend on. Declaring `drawn` also lets the pipeline read draw state directly
   * instead of inferring it from an AlreadyDrawn revert.
   */
  "function getOrder(uint256 orderId) view returns ((address buyer, uint96 price, bytes32 machineId, uint64 createdAt, uint64 deadline, uint8 status, bool drawn, bool turbo))",
  "function machines(bytes32 machineId) view returns (uint96 priceUsdg, bool enabled)",
  "function paused() view returns (bool)",
  // Permissionless by design (PackSale.sol:169): a buyer must never depend on us to get
  // their money back. We call it anyway so they do not have to know that.
  "function refund(uint256 orderId)",
  // Draw an order's payment out to fund its pack. See PackSale.drawForOpen.
  "function drawForOpen(uint256 orderId)",
  /**
   * CUSTOM ERRORS. These are not decoration — without them viem cannot NAME a revert, and
   * every `catch` that decides what to do next is blind.
   *
   * Three code paths matched on the error name in prose (`/AlreadyDrawn/i`) while this ABI
   * declared no errors at all, so viem produced "Unable to decode signature 0x7e62addd" and
   * the checks silently never fired. The drawn-order refund, the already-refunded
   * reconciliation and the resume-after-draw path were all dead on the money path.
   */
  "error AlreadyDrawn(uint256 orderId)",
  "error NotDrawn(uint256 orderId)",
  "error NotDrawer()",
  "error OrderNotPending(uint256 orderId, uint8 status)",
  "error DeadlineNotPassed(uint256 orderId, uint64 deadline)",
  "error MachineDisabled(bytes32 machineId)",
  "error DailyCapReached(uint32 cap)",
  "error TooManyOpenOrders(uint32 max)",
  "error TooManyOpenOrdersForBuyer(uint32 cap)",
  "error PriceAboveMax(uint96 price, uint96 max)",
  "function closeDrawnOrder(uint256 orderId, string reason)",
  "function drawer() view returns (address)",
]);

export const FULFILLER_ABI = parseAbi([
  "function fulfill(uint256 orderId, address expectedBuyer, (bytes32 solanaMintHash, bytes32 ccOpenTxHash, uint64 revealAt, uint64 userWindowEndsAt, uint64 ccWindowEndsAt) meta, string uri, bytes32 ccTxSigHash) returns (uint256)",
  "function burnAfterSell(uint256 tokenId)",
  "function mintForDeposit(address to, uint256 depositId, bytes32 solanaMintHash, (bytes32 solanaMintHash, bytes32 ccOpenTxHash, uint64 revealAt, uint64 userWindowEndsAt, uint64 ccWindowEndsAt) meta, string uri) returns (uint256)",
  "function mintedForDeposit(bytes32) view returns (uint256)",
  "function DEPOSIT_ID_BASE() view returns (uint256)",
]);

export const MIRROR_ABI = parseAbi([
  "function mintedForOrder(uint256 orderId) view returns (uint256)",
  // Whether MirrorNFT still trusts our Fulfiller. Gates deposits: see depositsSupported.
  "function operator() view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

/** Standalone so `getLogs` can infer the indexed argument names. */
export const MIRROR_TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

/**
 * Emitted by `burnForUnwrap` AFTER the mirror is burned. The signature must match
 * MirrorNFT.sol exactly — a wrong type changes the topic hash, the filter silently matches
 * nothing, and every withdraw request goes unseen while users' mirrors keep burning.
 */
export const UNWRAP_REQUESTED_EVENT = parseAbiItem(
  "event UnwrapRequested(uint256 indexed tokenId, address indexed owner, bytes solanaAddress, uint256 feePaidUsdg)",
);

export const USDG_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  // deBridge pulls the deposit with transferFrom, so the worker must approve it first.
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

/** PackSale.OrderStatus, mirrored. Kept in sync by name, not by number. */
export const ORDER_STATUS = ["NONE", "PENDING", "FULFILLED", "REFUNDED"] as const;
export type OnChainOrderStatus = (typeof ORDER_STATUS)[number];

export type OnChainOrder = {
  orderId: bigint;
  buyer: Address;
  price: bigint;
  machineCode: string;
  createdAt: number;
  deadline: number;
  status: OnChainOrderStatus;
};

export type CardMetaInput = {
  /** keccak of the Solana mint address. The mint itself lives off chain. */
  solanaMintHash: Hex;
  ccOpenTxHash: Hex;
  revealAt: number;
  userWindowEndsAt: number;
  ccWindowEndsAt: number;
};

/**
 * The NAME of the custom error a contract reverted with, or null.
 *
 * Matching on `err.message` was the bug: viem only spells an error out when the ABI declares
 * it, so a missing `error` entry turned every branch into dead code without a single test
 * failing. Walking the error chain and reading `errorName` fails loudly instead — if the ABI
 * entry is ever dropped again this returns null and the caller takes its safe path, rather
 * than a regex quietly never matching.
 */
export function revertErrorName(err: unknown): string | null {
  let e: unknown = err;
  for (let i = 0; i < 10 && e; i++) {
    const cur = e as { name?: string; data?: { errorName?: string }; cause?: unknown };
    if (cur.data?.errorName) return cur.data.errorName;
    e = cur.cause;
  }
  return null;
}

export class RhChain {
  private readonly cfg: Config;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  readonly workerAddress: Address;

  constructor(cfg: Config) {
    this.cfg = cfg;
    const account = privateKeyToAccount(cfg.rh.workerPrivateKey);
    this.workerAddress = account.address;

    const chain = {
      id: cfg.rh.chainId,
      name: "Robinhood Chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rh.rpcUrl] } },
    } as const;

    this.publicClient = createPublicClient({ chain, transport: http(cfg.rh.rpcUrl) });
    this.walletClient = createWalletClient({ account, chain, transport: http(cfg.rh.rpcUrl) });
  }

  // ---------------------------------------------------------------- reads

  async getOrder(orderId: bigint): Promise<OnChainOrder> {
    const o = await this.publicClient.readContract({
      address: this.cfg.rh.packSaleAddress,
      abi: PACK_SALE_ABI,
      functionName: "getOrder",
      args: [orderId],
    });
    return {
      orderId,
      buyer: o.buyer,
      price: o.price,
      machineCode: bytes32ToMachineId(o.machineId),
      createdAt: Number(o.createdAt),
      deadline: Number(o.deadline),
      status: ORDER_STATUS[o.status] ?? "NONE",
    };
  }

  /** Whether PackSale is paused. The guardian can stop sales without telling us. */
  async isPaused(): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.cfg.rh.packSaleAddress,
      abi: PACK_SALE_ABI,
      functionName: "paused",
    });
  }

  /**
   * Whether a mirror already exists for this order, read from the NFT contract rather than
   * our own database. The same question PackSale.forceRefund asks, and for the same reason:
   * our bookkeeping can be stale or wrong, the token either exists or it does not.
   */
  async mintedTokenFor(orderId: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.cfg.rh.mirrorAddress,
      abi: MIRROR_ABI,
      functionName: "mintedForOrder",
      args: [orderId],
    });
  }

  async machineIsLive(code: string): Promise<{ enabled: boolean; priceUsdg: bigint }> {
    const [priceUsdg, enabled] = await this.publicClient.readContract({
      address: this.cfg.rh.packSaleAddress,
      abi: PACK_SALE_ABI,
      functionName: "machines",
      args: [machineIdToBytes32(code)],
    });
    return { enabled, priceUsdg };
  }

  async headBlock(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }

  /** Send a prepared transaction, used for the bridge's own calldata. */
  async sendRaw(
    tx: { to: `0x${string}`; data: `0x${string}`; value: bigint },
    onSent?: (txHash: string) => void,
  ): Promise<string> {
    const hash = await this.walletClient.sendTransaction({
      account: this.walletClient.account!,
      chain: null,
      ...tx,
    });
    // Hand the hash back before the receipt wait below. The money has left at this point, so
    // the caller must be able to record that fact even if the wait times out.
    onSent?.(hash);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`bridge deposit reverted (tx ${hash})`);
    return hash;
  }

  /**
   * Make sure `spender` can pull `amount` of `token` from the worker wallet.
   *
   * deBridge moves the source ERC-20 with `transferFrom`, so a deposit from Robinhood Chain
   * reverts without an allowance. Nothing in this repo ever approved it: the worker's USDG
   * allowance to deBridge's contract was **zero on mainnet**, which meant every pack open
   * would have failed at the bridge step. The buyer's money would have gone into escrow and
   * come back out via the refund sweep, so nothing would be lost, but nothing would ever open
   * either. Found 19 Jul 2026 by checking the allowance before proving the outbound leg.
   *
   * Approves the EXACT amount needed rather than an unlimited allowance. The worker key is
   * hot and also holds the treasury, so an infinite approval to a third-party contract is
   * real standing risk for a saving of one transaction per open. Approving only when short
   * also means the common case (allowance already sufficient) costs nothing.
   */
  async ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<void> {
    const current = await this.publicClient.readContract({
      address: token,
      abi: USDG_ABI,
      functionName: "allowance",
      args: [this.workerAddress, spender],
    });
    if (current >= amount) return;

    const { request } = await this.publicClient.simulateContract({
      address: token,
      abi: USDG_ABI,
      functionName: "approve",
      args: [spender, amount],
      account: this.walletClient.account!,
    });
    const txHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`approve reverted (tx ${txHash})`);
  }

  /** Gas balance of the worker key. The pipeline stops rather than half-fulfilling. */
  async workerGasBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.workerAddress });
  }

  // ---------------------------------------------------------------- watching

  /**
   * Historical scan plus a poll for new orders.
   *
   * Polling rather than a websocket subscription: RH_WS_URL is optional and often unset, and
   * a dropped subscription fails silently in a way that looks exactly like "no orders", which
   * is the worst possible failure for a queue that holds customer money. Polling from a
   * stored block height is dull but cannot silently stall.
   */
  async getOrdersSince(fromBlock: bigint, toBlock?: bigint): Promise<{ orders: OnChainOrder[]; latestBlock: bigint }> {
    const latest = toBlock ?? (await this.publicClient.getBlockNumber());
    if (fromBlock > latest) return { orders: [], latestBlock: latest };

    /**
     * Scanned in bounded chunks, and the cursor advances per chunk.
     *
     * This used to request fromBlock..latest in one call. Most RPCs cap a log range (commonly
     * 2k to 10k blocks), so after a few hours of downtime the request exceeded the cap and
     * threw. The worker's catch logged "tick failed", the cursor never advanced, and every
     * subsequent tick threw identically: a permanent, silent stall in which buyers pay,
     * OrderCreated fires, and no order row is ever created.
     *
     * That failure looks exactly like "no orders", which the comment above correctly calls
     * the worst possible failure for a queue holding customer money.
     *
     * Returning `scannedTo` rather than `latest` on a partial scan is the other half: the
     * caller persists real progress, so a long backlog is worked through a chunk per tick
     * instead of being retried whole and failing whole.
     */
    const fetchChunk = (from: bigint, to: bigint) =>
      this.publicClient.getLogs({
        address: this.cfg.rh.packSaleAddress,
        event: PACK_SALE_ABI[0],
        fromBlock: from,
        toBlock: to,
      });

    const { logs, scannedTo } = await scanLogsInChunks(fromBlock, latest, fetchChunk);

    /**
     * THROWS on an undecodable log. It used to `.filter()` them away.
     *
     * This is the money-IN path: every one of these logs is a buyer who has already paid. A
     * dropped log meant no order row, no fulfilment and no alert, while the cursor advanced
     * past its block — so it was never re-read and the payment simply sat in escrow until the
     * deadline. Silent, and indistinguishable from a customer who never showed up.
     *
     * `unwrapRequests`, twenty lines below, already refuses to step over a log it cannot read.
     * This scanner was never given the same treatment. Throwing leaves the cursor where it is
     * so the batch retries and the failure is loud.
     */
    const orders = logs.map((l) => {
      if (
        l.args.orderId === undefined ||
        !l.args.buyer ||
        l.args.price === undefined ||
        !l.args.machineId ||
        l.args.deadline === undefined
      ) {
        throw new Error(
          `Undecodable OrderCreated log in block ${l.blockNumber} (tx ${l.transactionHash}): ` +
            `orderId=${l.args.orderId} buyer=${l.args.buyer} price=${l.args.price} ` +
            `machineId=${l.args.machineId} deadline=${l.args.deadline}. A buyer has paid and ` +
            `this order must not be skipped — refusing to advance the cursor past it.`,
        );
      }

      return {
        orderId: l.args.orderId,
        buyer: l.args.buyer,
        price: l.args.price,
        machineCode: bytes32ToMachineId(l.args.machineId),
        // Not in the event. getOrder fills these when the pipeline needs them.
        createdAt: 0,
        /**
         * NOT `?? 0`. A zero deadline is already in the past, so `refundableOrders` would treat
         * a brand-new order as expired the instant it was inserted and race the pipeline that
         * is trying to fulfil it. An unreadable deadline fails the batch above instead.
         */
        deadline: Number(l.args.deadline),
        status: "PENDING" as OnChainOrderStatus,
      };
    });

    return { orders, latestBlock: scannedTo };
  }

  // ---------------------------------------------------------------- writes

  /**
   * Mint the mirror and release escrow, atomically, through the Fulfiller.
   *
   * Idempotent by construction: MirrorNFT.mintedForOrder is checked first, and the contract
   * itself reverts with OrderAlreadyMinted if two workers race. A retry after a timeout is
   * therefore safe, which matters because "did my transaction land" is exactly the question
   * a crashed worker cannot answer locally.
   */
  async fulfillOrder(args: {
    orderId: bigint;
    expectedBuyer: Address;
    meta: CardMetaInput;
    tokenUri: string;
    ccTxSigHash: Hex;
  }): Promise<{ txHash: Hex; tokenId: bigint; alreadyMinted: boolean }> {
    const existing = await this.mintedTokenFor(args.orderId);
    if (existing !== 0n) {
      return { txHash: "0x" as Hex, tokenId: existing, alreadyMinted: true };
    }

    const params = [
      args.orderId,
      args.expectedBuyer,
      {
        solanaMintHash: args.meta.solanaMintHash,
        ccOpenTxHash: args.meta.ccOpenTxHash,
        revealAt: BigInt(args.meta.revealAt),
        userWindowEndsAt: BigInt(args.meta.userWindowEndsAt),
        ccWindowEndsAt: BigInt(args.meta.ccWindowEndsAt),
      },
      args.tokenUri,
      args.ccTxSigHash,
    ] as const;

    // Simulate first: a revert here is a bug or a race, and finding out before spending gas
    // gives a decodable error instead of an opaque failed transaction.
    const { request } = await this.publicClient.simulateContract({
      address: this.cfg.rh.fulfillerAddress,
      abi: FULFILLER_ABI,
      functionName: "fulfill",
      args: params,
      account: this.walletClient.account!,
    });

    const txHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`fulfill reverted on chain (tx ${txHash})`);

    const tokenId = await this.mintedTokenFor(args.orderId);
    if (tokenId === 0n) throw new Error(`fulfill landed but no token recorded for order ${args.orderId}`);

    return { txHash, tokenId, alreadyMinted: false };
  }

  /**
   * Mint a mirror for a DEPOSITED card, which has no PackSale order and no escrow.
   *
   * Mirrors `fulfillOrder`'s discipline exactly, and for the same reason: the identity that
   * must be unique is checked FIRST, from the chain, so a retry after a lost response
   * reconciles instead of minting a second mirror for one physical card. Here that identity is
   * the Solana mint, not an order id — the card is the thing being mirrored.
   *
   * The card's windows are set to zero. They govern the sell-back clock, and a deposited card
   * is never sold back; a non-zero value would imply a sale that must not happen.
   */
  async mintForDeposit(args: {
    to: Address;
    depositId: bigint;
    solanaMint: string;
    tokenUri: string;
  }): Promise<{ txHash: Hex; tokenId: bigint; alreadyMinted: boolean }> {
    const mintHash = keccak256(toHex(args.solanaMint));

    const existing = (await this.publicClient.readContract({
      address: this.cfg.rh.fulfillerAddress,
      abi: FULFILLER_ABI,
      functionName: "mintedForDeposit",
      args: [mintHash],
    })) as bigint;
    if (existing !== 0n) {
      return { txHash: "0x" as Hex, tokenId: existing, alreadyMinted: true };
    }

    const { request } = await this.publicClient.simulateContract({
      address: this.cfg.rh.fulfillerAddress,
      abi: FULFILLER_ABI,
      functionName: "mintForDeposit",
      args: [
        args.to,
        args.depositId,
        mintHash,
        {
          solanaMintHash: mintHash,
          ccOpenTxHash: mintHash, // no CC open for a deposit; the mint hash is the provenance
          revealAt: 0n,
          userWindowEndsAt: 0n,
          ccWindowEndsAt: 0n,
        },
        args.tokenUri,
      ],
      account: this.walletClient.account!,
    });

    const txHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`mintForDeposit reverted on chain (tx ${txHash})`);

    const tokenId = (await this.publicClient.readContract({
      address: this.cfg.rh.fulfillerAddress,
      abi: FULFILLER_ABI,
      functionName: "mintedForDeposit",
      args: [mintHash],
    })) as bigint;
    if (tokenId === 0n) throw new Error(`mintForDeposit landed but no token recorded for ${args.solanaMint}`);

    return { txHash, tokenId, alreadyMinted: false };
  }

  /**
   * Can deposits actually run right now?
   *
   * Two conditions, both read from chain: the configured Fulfiller must EXPOSE mintForDeposit
   * (an old Fulfiller does not), and MirrorNFT must still trust it as operator. Either being
   * false means a deposit would revert at the mint — after the user had already sent a real
   * card into the vault.
   *
   * Checked on chain rather than behind a flag we remember to flip, so the feature switches
   * itself on the moment the operator role is rotated and cannot be left advertised while
   * broken. False on any error, because "we could not confirm" and "it works" must never be
   * the same answer on a path that costs someone a card.
   */
  async depositsSupported(): Promise<boolean> {
    try {
      const [base, operator] = await Promise.all([
        this.publicClient.readContract({
          address: this.cfg.rh.fulfillerAddress,
          abi: FULFILLER_ABI,
          functionName: "DEPOSIT_ID_BASE",
        }) as Promise<bigint>,
        this.publicClient.readContract({
          address: this.cfg.rh.mirrorAddress,
          abi: MIRROR_ABI,
          functionName: "operator",
        }) as Promise<Address>,
      ]);
      if (base === 0n) return false;
      return operator.toLowerCase() === this.cfg.rh.fulfillerAddress.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Current holders of many mirrors at once.
   *
   * The collection is built from this rather than from who bought the pack. A mirror is an
   * ordinary ERC-721: it moves on transfer and on a marketplace sale, and the buyer's order
   * says nothing about where it went. Reading ownership per card is the only answer that stays
   * true — a card the user gave away must leave their collection, and one they were given must
   * appear in it.
   *
   * A token that cannot be read (burned, or an RPC hiccup) yields null and is simply omitted,
   * because showing a card as owned when we could not confirm it is the mistake that matters
   * here — it would offer actions that then fail against ownerOf.
   */
  async mirrorOwners(tokenIds: bigint[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    await Promise.all(
      tokenIds.map(async (id) => {
        try {
          const owner = (await this.publicClient.readContract({
            address: this.cfg.rh.mirrorAddress,
            abi: MIRROR_ABI,
            functionName: "ownerOf",
            args: [id],
          })) as Address;
          out.set(id.toString(), owner);
        } catch {
          out.set(id.toString(), null);
        }
      }),
    );
    return out;
  }

  /** Current holder of a mirror. Reverts for a token that does not exist. */
  async mirrorOwnerOf(tokenId: bigint): Promise<Address> {
    return this.publicClient.readContract({
      address: this.cfg.rh.mirrorAddress,
      abi: MIRROR_ABI,
      functionName: "ownerOf",
      args: [tokenId],
    });
  }

  /**
   * Who transferred this mirror into operator custody, read from the chain rather than taken
   * on trust from the caller. This is what makes the escrow self-authenticating: the address
   * that gave up the token is the address we owe, and no request body can change that.
   *
   * Returns null if the most recent inbound Transfer cannot be found, which must be treated
   * as "do not sell", never as "pay whoever asked".
   */
  async escrowDepositorOf(tokenId: bigint, fromBlock: bigint): Promise<Address | null> {
    const logs = await this.publicClient.getLogs({
      address: this.cfg.rh.mirrorAddress,
      event: MIRROR_TRANSFER_EVENT,
      args: { to: this.workerAddress, tokenId },
      fromBlock,
      toBlock: "latest",
    });
    return logs.at(-1)?.args.from ?? null;
  }

  /**
   * Every mirror that arrived in operator custody in a block range, oldest first.
   *
   * Mints also emit Transfer, from the zero address, but never to us — a mint goes straight
   * to the buyer — so no filtering is needed beyond `to`.
   */
  async inboundMirrorTransfers(
    fromBlock: bigint,
    toBlock?: bigint,
  ): Promise<{ transfers: { tokenId: bigint; from: Address }[]; latestBlock: bigint }> {
    const head = toBlock ?? (await this.headBlock());
    if (fromBlock > head) return { transfers: [], latestBlock: head };

    /**
     * Chunked, for the same reason getOrdersSince is — this one was missed when that fix
     * landed, and it is the more damaging of the two to get wrong.
     *
     * Unchunked, one `getLogs` covered fromBlock..head. Any failure — a range cap, a rate
     * limit, an RPC timeout — threw before the caller could persist its cursor, so the next
     * tick re-requested the same start against a NEWER head. The range grows every tick,
     * which makes the next call heavier and more likely to fail than the last. Observed in
     * production on 20 Jul as repeated "escrow tick failed / Too Many Requests" over a range
     * that widened from 80 to 131 blocks.
     *
     * An order that is never seen is recoverable: the buyer refunds permissionlessly once the
     * deadline passes. A DEPOSIT that is never seen is not. The mirror has already left the
     * user's wallet and no `escrow_deposits` row exists, so the sweeper — which only walks
     * rows it recorded — cannot hand it back either. The card sits in custody, unrecorded and
     * unreturned, until a human notices.
     */
    const { logs, scannedTo } = await scanLogsInChunks(fromBlock, head, (from, to) =>
      this.publicClient.getLogs({
        address: this.cfg.rh.mirrorAddress,
        event: MIRROR_TRANSFER_EVENT,
        args: { to: this.workerAddress },
        fromBlock: from,
        toBlock: to,
      }),
    );

    /**
     * A MINT is not a deposit. Exclude `from == 0x0`.
     *
     * ERC-721 emits `Transfer(0x0 -> owner)` when a token is created, and this query filters
     * only on `to`. That is harmless while buyers are strangers, but the operator wallet is
     * ALSO the escrow address, so an operator-bought card mints straight "into" escrow and
     * the watcher reads its own mint as somebody starting a sell-back.
     *
     * What followed was ugly: sell-back is disabled, so the deposit fell through to the
     * sweeper, which tried to hand the mirror back to the zero address. `safeTransferFrom`
     * to 0x0 reverts, so it retried every tick forever and raised a "cannot return it" alert
     * every 10 minutes — during the one test run where those logs matter most.
     *
     * Nothing was ever at risk of being burned (the transfer reverts rather than succeeding),
     * but the noise would have buried real signal. Found before the first open, not during it.
     */
    return {
      transfers: escrowDepositsOnly(
        logs.map((l) => ({ tokenId: l.args.tokenId!, from: l.args.from! })),
      ),
      // scannedTo, not head: on a partial scan the caller must persist real progress, or the
      // unread blocks are skipped and the deposits in them are lost for good.
      latestBlock: scannedTo,
    };
  }

  /**
   * Withdraw requests: `UnwrapRequested(tokenId, owner, solanaAddress, feePaidUsdg)`.
   *
   * The mirror is ALREADY BURNED when this event exists, so missing one means a user holds
   * nothing and has no record of their claim. Chunked for the same reason the other two
   * scanners are: an unbounded range fails wider every tick and never recovers.
   *
   * `solanaAddress` is raw 32 bytes on chain — the contract validates only the length. It is
   * decoded to base58 here, and validated properly by the destination guard before anything
   * is sent.
   */
  async unwrapRequests(
    fromBlock: bigint,
    toBlock?: bigint,
  ): Promise<{
    requests: { tokenId: bigint; owner: Address; solanaAddress: string }[];
    latestBlock: bigint;
  }> {
    const head = toBlock ?? (await this.headBlock());
    if (fromBlock > head) return { requests: [], latestBlock: head };

    const { logs, scannedTo } = await scanLogsInChunks(fromBlock, head, (from, to) =>
      this.publicClient.getLogs({
        address: this.cfg.rh.mirrorAddress,
        event: UNWRAP_REQUESTED_EVENT,
        fromBlock: from,
        toBlock: to,
      }),
    );

    const requests = [];
    for (const l of logs) {
      const tokenId = l.args.tokenId;
      const owner = l.args.owner;
      const raw = l.args.solanaAddress;
      // Same reasoning as the length check below: a burned mirror whose event we cannot read
      // must stop the batch, not be stepped over. The cursor stays put and the tick retries.
      if (tokenId === undefined || !owner || !raw) {
        throw new Error(
          `An UnwrapRequested log is missing tokenId, owner or destination. A mirror has been ` +
            `burned and its claim cannot be read. Refusing to advance past it.`,
        );
      }

      /**
       * 32 bytes exactly, or we cannot form an address.
       *
       * THROWS rather than `continue`. The contract enforces this length, so reaching here
       * means we are reading something we do not understand — but the mirror for this event
       * is ALREADY BURNED. Skipping quietly advanced the cursor past it, so the claim would
       * be lost permanently and silently, which is indistinguishable from robbing the user.
       * Throwing leaves the cursor where it is, so the batch retries and the failure is loud.
       */
      const bytes = Buffer.from(raw.slice(2), "hex");
      if (bytes.length !== 32) {
        throw new Error(
          `UnwrapRequested for token ${tokenId} carries a ${bytes.length}-byte destination, not 32. ` +
            `The mirror is already burned, so this claim must not be skipped. Needs a human.`,
        );
      }

      requests.push({ tokenId, owner, solanaAddress: bs58.encode(bytes) });
    }

    return { requests, latestBlock: scannedTo };
  }

  /** Hand a mirror back to its owner when a sell-back is abandoned before the card is sold. */
  async returnMirror(to: Address, tokenId: bigint): Promise<Hex> {
    const { request } = await this.publicClient.simulateContract({
      address: this.cfg.rh.mirrorAddress,
      abi: MIRROR_ABI,
      functionName: "safeTransferFrom",
      args: [this.workerAddress, to, tokenId],
      account: this.walletClient.account!,
    });
    const txHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`returnMirror reverted (tx ${txHash})`);
    return txHash;
  }

  /**
   * Take an order's payment out of escrow so it can fund the pack purchase.
   *
   * Without this the worker would have to front the full pack price from its own working
   * capital on every order and wait to be reimbursed at markFulfilled. That capital does not
   * exist, and it would scale with maxOpenOrders rather than with revenue.
   *
   * Safe to call twice: the contract is one-shot and reverts with AlreadyDrawn, which the
   * caller treats as "already done" rather than as a failure. That makes a crash between the
   * draw and the bridge recoverable instead of stranding the order.
   */
  async drawForOpen(orderId: bigint): Promise<Hex | "already-drawn"> {
    try {
      const { request } = await this.publicClient.simulateContract({
        address: this.cfg.rh.packSaleAddress,
        abi: PACK_SALE_ABI,
        functionName: "drawForOpen",
        args: [orderId],
        account: this.walletClient.account!,
      });
      const txHash = await this.walletClient.writeContract(request);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`drawForOpen reverted (order ${orderId}, tx ${txHash})`);
      return txHash;
    } catch (err) {
      if (revertErrorName(err) === "AlreadyDrawn") return "already-drawn";
      throw err;
    }
  }

  /**
   * Close a drawn order that can never be fulfilled, freeing its open-order slot.
   *
   * `openOrderCount` decrements only on fulfil or refund, and a DRAWN order cannot be
   * refunded by the contract. So without this every drawn-then-failed order holds its slot
   * forever, and five of them close the storefront for everyone. The float gate failing is
   * the documented common case, not an exotic one, so this is the normal path rather than an
   * emergency one.
   */
  async closeDrawnOrder(orderId: bigint, reason: string): Promise<Hex> {
    const { request } = await this.publicClient.simulateContract({
      address: this.cfg.rh.packSaleAddress,
      abi: PACK_SALE_ABI,
      functionName: "closeDrawnOrder",
      args: [orderId, reason],
      account: this.walletClient.account!,
    });
    const txHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`closeDrawnOrder reverted (order ${orderId})`);
    return txHash;
  }

  /**
   * Whether the deployed PackSale supports drawing, and who it will let draw.
   *
   * Called at boot, which is the whole point. `drawForOpen` is a NEW function: the contract
   * live today predates it. A worker that calls it unconditionally fails 100% of orders, and
   * only finds out when a real buyer pays. Two independent security reviews flagged exactly
   * that pairing as the top risk, and an earlier `drawerAddress()` helper claimed in its own
   * docstring to be "checked at boot" while having zero callers — the same dead-code bug this
   * codebase has now produced three times.
   *
   * So the worker asks the contract what it can do instead of assuming, and works correctly
   * against BOTH the old contract (operator fronts the money) and the new one (the buyer's
   * payment funds their own pack). That makes the deploy order unable to break anything.
   *
   * A revert means the function is absent. Any other read failure is rethrown: "the RPC is
   * down" must not be silently read as "this contract has no draw".
   */
  async drawSupport(): Promise<{ supported: boolean; drawer: Address | null }> {
    try {
      const drawer = await this.publicClient.readContract({
        address: this.cfg.rh.packSaleAddress,
        abi: PACK_SALE_ABI,
        functionName: "drawer",
      });
      return { supported: true, drawer };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // viem reports a missing function as a revert with no data.
      if (/revert|returned no data|ContractFunctionExecutionError/i.test(msg)) {
        return { supported: false, drawer: null };
      }
      throw err;
    }
  }

  /**
   * Refund a timed-out order, returning the buyer's escrowed USDG.
   *
   * `PackSale.refund` is permissionless and reverts unless the order is still PENDING and the
   * deadline has passed, so the chain — not our database — is the authority on whether this
   * is allowed. That makes the call safe to retry: a refund that already landed reverts with
   * OrderNotPending rather than paying twice.
   *
   * Simulating first means an order someone else already refunded (anyone can call this)
   * fails here, before a transaction is sent, instead of burning gas on a revert.
   */
  async refundOrder(orderId: bigint): Promise<Hex> {
    const { request } = await this.publicClient.simulateContract({
      address: this.cfg.rh.packSaleAddress,
      abi: PACK_SALE_ABI,
      functionName: "refund",
      args: [orderId],
      account: this.walletClient.account!,
    });
    const txHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`refund reverted (order ${orderId}, tx ${txHash})`);
    return txHash;
  }

  /**
   * Pay a sell-back in USDG.
   *
   * `onSent` fires the instant the transaction is broadcast, before the receipt wait. The
   * caller uses it to record the hash durably, which is what makes a retry safe: a receipt
   * timeout on a transfer that already landed must never look like "nothing happened", or the
   * seller gets paid twice. The callback is deliberately synchronous and its failure is
   * allowed to propagate — if we cannot record the hash, we must not continue as though we
   * had.
   */
  async payUsdg(to: Address, amount: bigint, onSent?: (txHash: Hex) => void): Promise<Hex> {
    const { request } = await this.publicClient.simulateContract({
      address: this.cfg.rh.usdgAddress,
      abi: USDG_ABI,
      functionName: "transfer",
      args: [to, amount],
      account: this.walletClient.account!,
    });
    const txHash = await this.walletClient.writeContract(request);
    onSent?.(txHash);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`payUsdg reverted (tx ${txHash})`);
    return txHash;
  }

  /**
   * How a previously broadcast transaction ended.
   *
   * Answers the question a resumed payout has to ask: the hash is on file, but did it land?
   * A transaction the node has never heard of throws, which is treated as "not successful" so
   * the caller retries rather than assuming a payment happened.
   */
  /**
   * Did this transaction succeed? `null` means WE DO NOT KNOW.
   *
   * This used to `catch { return false }`, collapsing three very different answers into one:
   * "it reverted", "it is still pending", and "the RPC is down". Callers use this to decide
   * whether an irreversible payment already happened, and both mistakes are expensive — treat
   * an unknown as a revert and you re-broadcast a payout that already landed; treat it as
   * success and the seller is never paid.
   *
   * So a definite `false` now means a receipt was fetched and it reverted, and nothing else.
   * Anything we could not determine is `null`, and callers must hold rather than act.
   */
  async txSucceeded(txHash: string): Promise<boolean | null> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash as Hex });
      return receipt.status === "success";
    } catch (err) {
      // Not yet mined is the common case and is emphatically not a failure.
      const name = err instanceof Error ? err.name : "";
      const message = err instanceof Error ? err.message : String(err);
      if (name === "TransactionReceiptNotFoundError" || /could not be found|not found/i.test(message)) {
        return null;
      }
      return null; // RPC error: unknown, never "reverted"
    }
  }

  async usdgBalance(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.cfg.rh.usdgAddress,
      abi: USDG_ABI,
      functionName: "balanceOf",
      args: [this.workerAddress],
    });
  }

  /** Burn a mirror once a sell-back payout has landed. */
  async burnAfterSell(tokenId: bigint): Promise<Hex> {
    const { request } = await this.publicClient.simulateContract({
      address: this.cfg.rh.fulfillerAddress,
      abi: FULFILLER_ABI,
      functionName: "burnAfterSell",
      args: [tokenId],
      account: this.walletClient.account!,
    });
    const txHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`burnAfterSell reverted (tx ${txHash})`);
    return txHash;
  }
}


/**
 * Walk a block range in bounded chunks, keeping whatever was scanned before a failure.
 *
 * Extracted from getOrdersSince so it can be tested without a live RPC, and because the
 * behaviour it encodes is subtle enough to be worth pinning.
 *
 * The bug it fixes: a single getLogs over fromBlock..latest. Most RPCs cap a log range
 * (commonly 2k to 10k blocks), so after a few hours of downtime the request exceeded the cap
 * and threw. The worker's catch logged "tick failed", the cursor never advanced, and every
 * later tick threw identically. Buyers pay, OrderCreated fires, and no order is ever created:
 * a permanent silent stall that is indistinguishable from "no orders".
 *
 * Two rules make the recovery work:
 *
 *   - a partial scan reports how far it actually got, so the caller persists real progress
 *     and a long backlog drains a chunk per tick instead of failing whole every time
 *   - a failure on the FIRST chunk rethrows, because that is a genuine RPC fault rather than
 *     a range limit, and advancing the cursor past unread blocks would lose orders for good
 */
export async function scanLogsInChunks<T>(
  fromBlock: bigint,
  latest: bigint,
  fetchChunk: (from: bigint, to: bigint) => Promise<T[]>,
  chunkSize = 2_000n,
): Promise<{ logs: T[]; scannedTo: bigint }> {
  const logs: T[] = [];
  let cursor = fromBlock;
  let scannedTo = latest;

  while (cursor <= latest) {
    const end = cursor + chunkSize - 1n < latest ? cursor + chunkSize - 1n : latest;
    try {
      logs.push(...(await fetchChunk(cursor, end)));
    } catch (err) {
      if (cursor === fromBlock) throw err;
      scannedTo = cursor - 1n;
      break;
    }
    cursor = end + 1n;
  }

  return { logs, scannedTo };
}


/** The zero address: the `from` of every ERC-721 mint. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Keep only transfers that represent somebody GIVING US a mirror, discarding mints.
 *
 * Exported and pure so it can be tested against the real implementation rather than a copy
 * of it. See inboundMirrorTransfers for why mints have to go.
 */
export function escrowDepositsOnly<T extends { from: string }>(transfers: T[]): T[] {
  return transfers.filter((t) => t.from.toLowerCase() !== ZERO_ADDRESS);
}
