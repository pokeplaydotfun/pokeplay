/**
 * Who a card may be sent to.
 *
 * Split out of the component so the rules can be tested. A transfer is irreversible — there
 * is no undo, no support ticket and no clawback — so these are the last thing standing
 * between a user and a card that is simply gone.
 */
type Check = { ok: true } | { ok: false; reason: string };

/**
 * Everything checkable about a destination, without touching the chain.
 *
 * Exported and pure so the rules are testable and stated in one place rather than scattered
 * through the component.
 */
export function checkRecipient(
  raw: string,
  self: string | undefined,
  escrow: string | null,
): Check {
  const to = raw.trim();
  if (!to) return { ok: false, reason: "Enter the address to send to." };

  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    return {
      ok: false,
      reason: "That is not a Robinhood Chain address. It should start 0x and be 42 characters.",
    };
  }

  if (/^0x0+$/.test(to)) {
    return { ok: false, reason: "That is the zero address. A card sent there is destroyed." };
  }

  if (self && to.toLowerCase() === self.toLowerCase()) {
    return { ok: false, reason: "That is your own address — the card is already there." };
  }

  /**
   * The escrow address is the footgun this check exists for.
   *
   * Sending a mirror there IS a sell-back: it is how one is started, no website involved. So a
   * user pasting it expecting to "send a card to PWA" would instead sell it, irreversibly,
   * at whatever the current quote is. Sell-back has its own deliberate flow; this is not it.
   */
  if (escrow && to.toLowerCase() === escrow.toLowerCase()) {
    return {
      ok: false,
      reason:
        "That is the sell-back address. Sending a card there sells it rather than transferring " +
        "it. Use Sell back if that is what you want.",
    };
  }

  return { ok: true };
}

