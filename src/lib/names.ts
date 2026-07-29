/**
 * Address -> username, resolved against the wager app's `/api/names`.
 *
 * Shared because the cards leaderboard exists TWICE — standalone at /cards/leaderboards, and
 * again as the "Cards" tab of /leaderboard — and both need the same treatment. Fixing only one
 * is exactly the bug this module exists to stop; if a third surface ever shows card rows, it
 * imports this rather than growing another copy.
 *
 * Usernames live only in pokeplay's database. The cards backend has no concept of one, so
 * without this its boards can only ever print wallets while the battles board shows names for
 * the same people.
 *
 * ⚠ A wallet with "Hide my wallet" set is deliberately absent from the response, so it keeps
 * showing as an address. The server withholds it: returning a name for a hidden wallet would
 * tie that name to a wallet, which is the exact association the setting prevents.
 *
 * Fails soft on purpose. Every error path returns {}, so a slow, rate-limited or broken lookup
 * degrades to the addresses the board displayed before — it can never blank or delay a ranking.
 */
export async function resolveNames(addresses: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))].slice(0, 100)
  if (unique.length === 0) return {}
  try {
    const res = await fetch(`/api/names?addresses=${unique.join(',')}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return {}
    const body = (await res.json()) as { names?: { address: string; name: string }[] }
    return Object.fromEntries((body.names ?? []).map((n) => [n.address.toLowerCase(), n.name]))
  } catch {
    return {}
  }
}
