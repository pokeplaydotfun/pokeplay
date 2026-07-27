/**
 * Turning chain and wallet failures into sentences a person can act on.
 *
 * Left alone, a failed transaction surfaces as something like
 * "execution reverted: 0x0f2ca6e7" or a 400-character viem trace. That tells a user nothing
 * except that they should probably stop using the site.
 *
 * Our contracts use named custom errors, so the cause is knowable. Each one below is mapped
 * to what actually happened and, where there is one, what to do about it.
 */

/** Custom errors from PackSale, MirrorNFT and Marketplace, by name. */
const CONTRACT_ERRORS: Record<string, string> = {
  // PackSale
  MachineDisabled: "That pack is not on sale right now.",
  PriceAboveMax: "The price changed while you were buying. Try again.",
  DailyCapReached: "Today's limit has been reached. Try again tomorrow.",
  // The cap is GLOBAL, not per buyer. The old copy said "You have packs still opening",
  // which is simply false for someone who has never bought anything.
  TooManyOpenOrders: "Too many packs are opening right now. Try again in a minute.",
  // This one IS about the buyer, unlike TooManyOpenOrders which is global.
  TooManyOpenOrdersForBuyer: "You already have packs opening. Wait for one to finish, then try again.",
  OrderNotPending: "That order has already been settled.",
  DeadlineNotPassed: "This order can still be fulfilled, so it cannot be refunded yet.",
  AlreadyDrawn: "This order is already being fulfilled and will complete shortly.",
  UnexpectedTokenBalance: "The payment did not arrive as expected. Nothing has been charged.",
  EnforcedPause: "Buying is paused at the moment. Nothing has been charged.",

  // Marketplace
  NotListed: "That card is no longer for sale.",
  AlreadyListed: "That card is already listed.",
  NotSeller: "Only the seller can change this listing.",
  NotOwner: "You do not own that card.",
  NotApproved: "You need to approve the marketplace to move this card first.",
  PriceZero: "Enter a price above zero.",
  AmountZero: "Enter an amount above zero.",
  CannotBuyOwnListing: "You cannot buy your own listing.",
  CannotOfferOnOwnCard: "You cannot make an offer on your own card.",
  PriceChanged: "The seller changed the price. Refresh and try again.",
  OfferChanged: "The offer changed. Refresh and try again.",
  SellerNoLongerOwns: "The seller no longer holds that card, so this listing cannot be filled.",
  ApprovalRevoked: "The seller withdrew permission to move this card.",
  OfferExpired: "That offer has expired.",
  NoOffer: "That offer is no longer there.",
  OfferorCannotPay: "The buyer no longer has the funds for that offer.",
  TooManyOffers: "This card has too many offers already. Try again later.",
  ExpiryInPast: "Pick an expiry in the future.",

  // MirrorNFT
  NotTokenOwner: "You do not own that card.",
  InvalidSolanaAddress: "That Solana address is not valid.",
  QuoteExpired: "The quote expired. Try again.",
  TokenDoesNotExist: "That card does not exist.",
  NotInCustody: "That card is not in the vault, so it cannot be sold back.",
  CustodianNotSet: "Sell-back is not configured right now. Nothing has been charged.",
  QuoteTokenMismatch: "That quote is for a different card. Refresh and try again.",
  BadQuoteSigner: "That quote could not be verified. Refresh and try again.",
};

/** Wallet and RPC failures, matched on the text wallets actually produce. */
const PATTERNS: [RegExp, string][] = [
  [/user rejected|user denied|rejected the request/i, ""], // cancelling is not an error
  [/insufficient funds/i, "Not enough in your wallet to cover this and the gas fee."],
  [/transfer amount exceeds balance|ERC20InsufficientBalance/i, "Not enough USDG in your wallet."],
  [/ERC20InsufficientAllowance/i, "The approval was not high enough. Try again and approve the full amount."],
  [/nonce too low|already known|replacement transaction/i, "A transaction is already going through. Wait for it to finish."],
  /**
   * Chain mismatch, in the several shapes wallets actually produce it.
   *
   * viem throws ChainMismatchError when the wallet's chain differs from the one the write
   * targets. The site's own network guard reads useChainId, so a wallet that reports its chain
   * inconsistently — or switches without telling the page — passes the guard and then fails at
   * the send. OKX is a likely candidate for exactly that.
   */
  [
    /chain ?mismatch|wrong network|unsupported chain|does not match the target chain|ChainMismatchError|chain of the connect/i,
    "Your wallet is on a different network to the site. Switch it to Robinhood Chain and try again.",
  ],
  [
    /method .*not (supported|found)|unsupported method|does not support/i,
    "Your wallet refused part of this request. If it is OKX, updating the extension usually fixes it.",
  ],
  [/gas required exceeds|intrinsic gas|out of gas/i, "The transaction ran out of gas. Try again."],
  [/timeout|timed out/i, "That took too long to confirm. Check your wallet before trying again."],
  [/fetch failed|network ?error|failed to fetch/i, "Could not reach the network. Check your connection."],
  [/rate limit|429|too many requests/i, "Too many requests right now. Wait a moment and try again."],
];

/**
 * @returns A sentence for the user, or "" if they simply cancelled, which is not a failure
 *          and should clear the state rather than display anything.
 */
export function humanError(err: unknown, fallback = "Something went wrong."): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (!raw) return fallback;

  /**
   * Ask viem for the error's NAME, rather than searching its prose for one.
   *
   * The prose search that used to live here could never match: naming a custom error requires
   * an `error` entry in the ABI, and there were none, so viem only ever had a selector like
   * 0x0f2ca6e7 to report. Every entry in the map above was unreachable and every failed
   * transaction on the site said "Something went wrong". The ABI entries exist now, and this
   * reads the decoded name instead of hoping it appears in a sentence.
   */
  const named = errorNameOf(err);
  if (named && CONTRACT_ERRORS[named]) return CONTRACT_ERRORS[named];

  // Prose fallback, kept only for errors thrown by something other than a contract call.
  for (const [name, text] of Object.entries(CONTRACT_ERRORS)) {
    if (new RegExp(`\\b${name}\\b`).test(raw)) return text;
  }

  for (const [re, text] of PATTERNS) {
    if (re.test(raw)) return text;
  }

  /**
   * Nothing matched. Say the fallback AND what the wallet actually said.
   *
   * Discarding the raw message was right for a hex selector or a stack trace, and wrong for
   * everything else: it turned "OKX said X" into "the purchase did not go through", which is
   * unactionable for the user and undiagnosable for us. A report of that message is how this
   * change came to be written, and there was nothing in it to work from.
   *
   * So a first line that reads like a sentence is appended; anything that looks like a hex
   * blob, a stack trace or a URL dump is still withheld.
   */
  const first = raw.split("\n")[0]?.trim() ?? "";
  const readable =
    first.length > 0 &&
    first.length <= 160 &&
    !/^0x[0-9a-f]+$/i.test(first) &&
    !/\bat\s+\w+.*\(/.test(first) &&
    /[a-z]{3}/i.test(first);

  return readable ? `${fallback} Your wallet said: ${first}` : fallback;
}

/**
 * The decoded custom-error name, if this was a contract revert viem could decode.
 *
 * Walks the `cause` chain rather than importing viem's error classes and using instanceof:
 * the shape is stable, and a version bump that reorganises those classes would silently turn
 * every message back into "Something went wrong" — the exact failure this file exists to stop.
 */
export function errorNameOf(err: unknown): string | null {
  let node: unknown = err;
  for (let depth = 0; node && depth < 10; depth++) {
    const data = (node as { data?: { errorName?: string } }).data;
    if (data && typeof data.errorName === "string") return data.errorName;
    const name = (node as { errorName?: string }).errorName;
    if (typeof name === "string") return name;
    node = (node as { cause?: unknown }).cause;
  }
  return null;
}

/** True when the user simply cancelled, so callers can reset silently. */
export function isUserRejection(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return /user rejected|user denied|rejected the request/i.test(raw);
}
