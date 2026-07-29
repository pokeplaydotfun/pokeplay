import { useEffect, useState } from 'react'
import { API_BASE } from '../slabs/client'

/**
 * Live fee and market-cap dashboard for the token.
 *
 * The numbers come from the gacha backend's `/token/stats`, which reads the Pons pool
 * directly. It reports `live: false` until `PONS_TOKEN_ADDRESS` is configured on the box, so
 * this whole section is safe to ship BEFORE the token launches: it shows a waiting state, not
 * a wall of zeroes.
 *
 * ⚠ Zeroes and dashes are not interchangeable here. A "$0" beside "Fees generated" reads as
 * "this is live and nobody is trading", which is a claim about the token. Until the server says
 * `live`, every figure stays a dash and the panel says plainly that it is not launched.
 *
 * ⚠ Path: this must go to `API_BASE` (the gacha backend, served at /slabs-api), NOT to
 * `/api/token/stats`. On the other deployment the gacha backend IS /api, so the ported copy in
 * src/slabs/Token.tsx hardcodes that path and would 404 here — it went unnoticed only because
 * /cards/token redirects away and that page is unreachable.
 */
type Stats = {
  live: boolean
  tokenAddress?: string
  poolAddress?: string
  feesEth?: number
  feesUsd?: number
  priceUsd?: number
  marketCapUsd?: number
}

/** Refresh cadence. Fees move with trading, not with the clock, so a slow poll is plenty. */
const REFRESH_MS = 60_000

const usd = (n: number) =>
  n >= 1000
    ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Sub-cent prices are normal for a new token, so significant digits beat fixed decimals. */
const price = (n: number) =>
  n >= 0.01
    ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
    : `$${n.toPrecision(3)}`

export function TokenStats() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!API_BASE) return
    let cancelled = false

    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/token/stats`, { signal: AbortSignal.timeout(10_000) })
        if (!res.ok) throw new Error(String(res.status))
        const body = (await res.json()) as Stats
        if (!cancelled) {
          setStats(body)
          setFailed(false)
        }
      } catch {
        // Fails quiet: a stats outage must not put an error banner on the token page. The
        // previous reading stays on screen, and a first failure simply shows dashes.
        if (!cancelled) setFailed(true)
      }
    }

    void load()
    const id = setInterval(() => void load(), REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const live = stats?.live === true
  const show = (v: number | undefined, fmt: (n: number) => string) =>
    live && v != null ? fmt(v) : '—'

  return (
    <div className="tk__block">
      <div className="tk__block-head">
        <div className="eyebrow">Token</div>
        <h3>Fees and market cap, live</h3>
        <p>
          {live
            ? 'Read from the Pons pool and refreshed every minute.'
            : 'These figures start reporting the moment the token is launched.'}
        </p>
      </div>

      <div className="tk__stats">
        <div className="tk__stat">
          <span className="tk__stat-label">Fees generated</span>
          <span className="tk__stat-value">{show(stats?.feesUsd, usd)}</span>
          <span className="tk__stat-sub">
            {live && stats?.feesEth != null ? `${stats.feesEth.toFixed(4)} ETH` : 'Not launched'}
          </span>
        </div>

        <div className="tk__stat">
          <span className="tk__stat-label">Market cap</span>
          <span className="tk__stat-value">{show(stats?.marketCapUsd, usd)}</span>
          <span className="tk__stat-sub">
            {live && stats?.priceUsd != null ? `${price(stats.priceUsd)} per token` : 'Not launched'}
          </span>
        </div>
      </div>

      {!live && (
        <p className="tk__stats-note">
          {failed
            ? 'Live figures are unavailable right now. They will reappear on their own.'
            : 'The token has not launched yet, so there are no fees or market cap to report.'}
        </p>
      )}
    </div>
  )
}
