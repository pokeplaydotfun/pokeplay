/**
 * Value policy: which cards may leave, and which may not.
 *
 * ONE implementation, used by every layer that enforces it. The API, the escrow sweeper and
 * the frontend all ask the same question, and this codebase's recurring failure has been two
 * layers answering the same question slightly differently. A card that the UI blocks but the
 * sweeper accepts is worse than no limit at all, because it looks safe.
 */

/** Insured value is stored as a 6dp base-unit string, the same as USDG. */
const USD_SCALE = 1_000_000n;

/**
 * Is this card too valuable to sell back or withdraw?
 *
 * @param insuredValueUsd  the card's stored `insured_value_usd`, 6dp base units. Null or
 *                         empty means we do not know what the card is worth, which is
 *                         treated as OVER the limit: refusing a card we cannot price is the
 *                         safe direction, and it matches the sell path already refusing to
 *                         quote without an insured value.
 * @param maxUsd           whole dollars. 0 disables the cap entirely.
 */
export function exceedsValueLimit(insuredValueUsd: string | null | undefined, maxUsd: number): boolean {
  // A non-finite limit means a malformed Config, which loadConfig() cannot produce (num()
  // always yields a number, defaulting to 100). Treated as "no cap" rather than throwing,
  // because this runs inside the escrow sweeper: crashing there would strand the cards it
  // exists to hand back, which is a worse outcome than a cap that was never configured.
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) return false;
  if (!insuredValueUsd) return true; // unknown value: refuse rather than guess
  let value: bigint;
  try {
    value = BigInt(insuredValueUsd);
  } catch {
    return true; // unparseable is also unknown
  }
  // Strictly greater: a card insured at exactly the limit is allowed through.
  return value > BigInt(maxUsd) * USD_SCALE;
}

/**
 * The message shown to a user whose card is over the limit.
 *
 * Deliberately generic: it names no threshold and no card, because the operator did not want
 * the specific value surfaced to users. The precise reason is still machine-readable in the
 * response (`code` and `limitUsd`) and spelled out in the operator alerts, so support and
 * debugging lose nothing.
 *
 * Kept here so the API and the UI cannot word it differently. No em dashes, per house style.
 */
export function valueLimitMessage(_maxUsd: number): string {
  return "This feature is temporarily unavailable.";
}

/** Machine-readable form, so the UI can branch on the reason rather than match on text. */
export const VALUE_LIMIT_CODE = "CARD_VALUE_ABOVE_LIMIT";
