/**
 * Minimal ABIs — only the functions and events the frontend actually touches.
 * Kept hand-written rather than generated so the surface the UI can reach stays visible.
 * Must stay in sync with contracts/src/*.sol.
 */

export const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

export const PACK_SALE_ABI = [
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [{ name: "machineId", type: "bytes32" }],
    outputs: [{ name: "orderId", type: "uint256" }],
  },
  {
    type: "function",
    name: "machines",
    stateMutability: "view",
    inputs: [{ name: "machineId", type: "bytes32" }],
    outputs: [
      { name: "priceUsdg", type: "uint96" },
      { name: "enabled", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "packsLeftToday",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  // Read together so the UI can say "the store is busy" BEFORE a buyer pays gas to discover
  // it. The cap is global, so a queue is a property of the storefront, not of the buyer.
  { type: "function", name: "openOrderCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxOpenOrders", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  // The per-buyer cap, live at 2. Without these two the pre-flight check below can only see
  // the global limit, so the most likely revert for a real user is the one it cannot warn about.
  { type: "function", name: "openOrdersOf", stateMutability: "view", inputs: [{ name: "buyer", type: "address" }], outputs: [{ type: "uint32" }] },
  { type: "function", name: "maxOpenOrdersPerBuyer", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [],
  },
  {
    // The orderId the worker keys everything off. Read it from this event rather than the
    // buy() return value — a return value is not observable from a transaction receipt.
    type: "event",
    name: "OrderCreated",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "machineId", type: "bytes32", indexed: true },
      { name: "price", type: "uint256", indexed: false },
      { name: "deadline", type: "uint64", indexed: false },
      // Added in the 20 Jul redeploy. Its presence CHANGES THE TOPIC HASH, so this and the
      // worker's copy must move together or order detection silently matches nothing.
      { name: "turbo", type: "bool", indexed: false },
    ],
  },

  /**
   * Custom errors. These are NOT optional decoration.
   *
   * viem can only give a revert a NAME if the name is in the ABI. Without these entries a
   * revert arrives as a bare selector like 0x0f2ca6e7, `errorName` is undefined, and every
   * message keyed on the cause is unreachable — which is exactly what shipped: the whole
   * error map in errors.ts was dead, so every failed buy read "Something went wrong."
   *
   * Signatures must match contracts/src/*.sol exactly, argument types included, or the
   * selector differs and the error stays unnamed.
   */
  { type: "error", name: "MachineDisabled", inputs: [{ name: "machineId", type: "bytes32" }] },
  { type: "error", name: "DailyCapReached", inputs: [{ name: "cap", type: "uint32" }] },
  { type: "error", name: "TooManyOpenOrders", inputs: [{ name: "cap", type: "uint32" }] },
  { type: "error", name: "TooManyOpenOrdersForBuyer", inputs: [{ name: "cap", type: "uint32" }] },
  { type: "error", name: "PriceAboveMax", inputs: [{ name: "price", type: "uint256" }, { name: "maxPrice", type: "uint256" }] },
  { type: "error", name: "OrderNotPending", inputs: [{ name: "orderId", type: "uint256" }, { name: "status", type: "uint8" }] },
  { type: "error", name: "DeadlineNotPassed", inputs: [{ name: "orderId", type: "uint256" }, { name: "deadline", type: "uint64" }] },
  { type: "error", name: "AlreadyDrawn", inputs: [{ name: "orderId", type: "uint256" }] },
  { type: "error", name: "UnexpectedTokenBalance", inputs: [] },
  { type: "error", name: "EnforcedPause", inputs: [] },
] as const;

/**
 * Marketplace: approval-based listings and allowance-based offers. Neither ever moves an
 * asset into the contract, so every write here is a permission grant plus a record, and the
 * fillability views exist so the UI can grey out a stale row instead of letting a user
 * discover the problem through a reverted transaction.
 */
export const MARKETPLACE_ABI = [
  { type: "function", name: "list", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }, { name: "priceUsdg", type: "uint96" }], outputs: [] },
  { type: "function", name: "updatePrice", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }, { name: "priceUsdg", type: "uint96" }], outputs: [] },
  { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "buy", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }, { name: "expectedPriceUsdg", type: "uint96" }], outputs: [] },
  { type: "function", name: "makeOffer", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }, { name: "amountUsdg", type: "uint96" }, { name: "expiry", type: "uint64" }], outputs: [] },
  { type: "function", name: "withdrawOffer", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "acceptOffer", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }, { name: "offeror", type: "address" }, { name: "expectedAmountUsdg", type: "uint96" }], outputs: [] },
  {
    type: "function",
    name: "getListing",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "tuple", components: [{ name: "seller", type: "address" }, { name: "priceUsdg", type: "uint96" }] }],
  },
  { type: "function", name: "isFillable", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "getOffers",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "offerors", type: "address[]" },
      { name: "amounts", type: "uint96[]" },
      { name: "expiries", type: "uint64[]" },
      { name: "fillable", type: "bool[]" },
    ],
  },
  {
    type: "function",
    name: "priceBreakdown",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "price", type: "uint256" }, { name: "fee", type: "uint256" }, { name: "sellerReceives", type: "uint256" }],
  },
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },

  // See the note on PACK_SALE_ABI's errors: without these the marketplace's failures are
  // unnamed selectors and every message keyed on them is unreachable.
  { type: "error", name: "NotListed", inputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "error", name: "AlreadyListed", inputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "error", name: "NotSeller", inputs: [{ name: "tokenId", type: "uint256" }, { name: "caller", type: "address" }] },
  { type: "error", name: "NotOwner", inputs: [{ name: "tokenId", type: "uint256" }, { name: "caller", type: "address" }] },
  { type: "error", name: "NotApproved", inputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "error", name: "PriceZero", inputs: [] },
  { type: "error", name: "AmountZero", inputs: [] },
  { type: "error", name: "CannotBuyOwnListing", inputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "error", name: "CannotOfferOnOwnCard", inputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "error", name: "PriceChanged", inputs: [{ name: "expected", type: "uint256" }, { name: "actual", type: "uint256" }] },
  { type: "error", name: "OfferChanged", inputs: [{ name: "expected", type: "uint256" }, { name: "actual", type: "uint256" }] },
  { type: "error", name: "SellerNoLongerOwns", inputs: [{ name: "tokenId", type: "uint256" }, { name: "seller", type: "address" }] },
  { type: "error", name: "ApprovalRevoked", inputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "error", name: "OfferExpired", inputs: [{ name: "tokenId", type: "uint256" }, { name: "offeror", type: "address" }, { name: "expiry", type: "uint64" }] },
  { type: "error", name: "NoOffer", inputs: [{ name: "tokenId", type: "uint256" }, { name: "offeror", type: "address" }] },
  { type: "error", name: "OfferorCannotPay", inputs: [{ name: "offeror", type: "address" }, { name: "amountUsdg", type: "uint256" }] },
  { type: "error", name: "TooManyOffers", inputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "error", name: "ExpiryInPast", inputs: [{ name: "expiry", type: "uint64" }] },
  { type: "error", name: "EnforcedPause", inputs: [] },
] as const;

/** Only the pieces of ERC-721 the marketplace flow needs. */
export const MIRROR_NFT_ABI = [
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getApproved", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "isApprovedForAll", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "operator", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "setApprovalForAll", stateMutability: "nonpayable", inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }], outputs: [] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "string" }] },
  // Sending the mirror to operator custody is what commits a sell-back. safeTransferFrom
  // rather than transferFrom so a destination that cannot receive an ERC-721 reverts here,
  // instead of stranding the card at an address that can never send it back.
  { type: "function", name: "safeTransferFrom", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "tokenId", type: "uint256" }], outputs: [] },

  /**
   * Burn the mirror to claim the real Solana asset. IRREVERSIBLE: the mirror is destroyed
   * before the event our relayer acts on is even emitted, so there is no escrow to unwind.
   *
   * The quote tuple and signature are ignored on chain when unwrapFeeBps is 0 or the CC
   * window has closed — the live fee is 0 — and the contract prescribes zeroes and empty
   * bytes for that case.
   */
  {
    type: "function",
    name: "burnForUnwrap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "solanaAddress", type: "bytes" },
      {
        name: "quote",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "insuredValueUsdg", type: "uint256" },
          { name: "expiry", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },

  // Whether anything has been minted yet. 1 means the collection is empty, which decides
  // whether the explorer has a token page to link to at all.
  { type: "function", name: "nextTokenId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },

  { type: "error", name: "NotTokenOwner", inputs: [] },
  { type: "error", name: "InvalidSolanaAddress", inputs: [] },
  { type: "error", name: "QuoteExpired", inputs: [{ name: "expiry", type: "uint256" }] },
  { type: "error", name: "TokenDoesNotExist", inputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "error", name: "NotInCustody", inputs: [{ name: "tokenId", type: "uint256" }, { name: "holder", type: "address" }] },
  { type: "error", name: "CustodianNotSet", inputs: [] },
  // Latent today because unwrapFeeBps is 0, so burnForUnwrap never reaches the quote path.
  // The moment a nonzero fee is set these fire on every in-window withdraw, and without
  // them the user sees a bare selector under a message promising their card is safe.
  { type: "error", name: "QuoteTokenMismatch", inputs: [] },
  { type: "error", name: "BadQuoteSigner", inputs: [{ name: "recovered", type: "address" }] },
] as const;
