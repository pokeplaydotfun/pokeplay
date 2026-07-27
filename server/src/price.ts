/**
 * A cached ETH/USD spot price, used only to DISPLAY a dollar-denominated
 * tournament prize in ETH (and vice-versa). Nothing here decides a payout — the
 * prize is a fixed dollar amount the organiser pays by hand, and the on-chain
 * entry pot is settled by the contract. This is presentation, so it fails soft:
 * if the feed is unreachable the last good price is kept, and `ethUsd()` returns
 * null until the very first fetch succeeds (the UI then just omits the ETH line).
 *
 * The value is refreshed on a timer and read synchronously by request handlers,
 * so a slow or down price API never blocks a page.
 */

const REFRESH_MS = 5 * 60 * 1000
const SOURCE = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'

let cached: number | null = null
let lastFetched = 0

/** The last known ETH price in USD, or null if we have never fetched one. */
export function ethUsd(): number | null {
  return cached
}

async function refresh(): Promise<void> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(SOURCE, { signal: ctrl.signal }).finally(() => clearTimeout(timer))
    if (!res.ok) return
    const body = (await res.json()) as { ethereum?: { usd?: number } }
    const price = body?.ethereum?.usd
    // Guard against a garbage response quietly poisoning every prize on the site.
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
      cached = price
      lastFetched = Date.now()
    }
  } catch {
    // Network error / abort / bad JSON — keep the last good price.
  }
}

/** Start the background refresh loop. Safe to call once at boot. */
export function startPriceFeed(): void {
  void refresh()
  const id = setInterval(() => void refresh(), REFRESH_MS)
  // Never keep the process alive just for the price ticker.
  if (typeof id === 'object' && 'unref' in id) (id as { unref: () => void }).unref()
}

/** For diagnostics: how stale the cached price is, in seconds (Infinity if none). */
export function priceAgeSeconds(): number {
  return cached === null ? Infinity : Math.floor((Date.now() - lastFetched) / 1000)
}
