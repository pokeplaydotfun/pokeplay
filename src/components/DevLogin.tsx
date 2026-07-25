import { useEffect, useState } from 'react'
import { api, isDevSession, setToken } from '../lib/api'

/**
 * Local-only sign-in shortcut, so one person can open two windows and play
 * themselves without two funded wallets.
 *
 * The server decides whether this exists — it 404s the endpoint unless
 * DEV_LOGIN=1 and NODE_ENV is not production. This component simply hides
 * itself when the probe fails, so shipping it to production is inert.
 */
export function DevLogin() {
  const [accounts, setAccounts] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const signInAs = async (who: string, reload = true) => {
    setBusy(who)
    try {
      const { token } = await api.post<{ token: string }>('/api/auth/dev-login', { who })
      setToken(token, true)
      // Full reload so every hook picks the new session up cleanly.
      if (reload) location.reload()
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    let cancelled = false

    void (async () => {
      let list: string[] | null = null
      try {
        list = (await api.get<{ accounts: string[] }>('/api/auth/dev-accounts')).accounts
      } catch {
        list = null
      }
      if (cancelled) return
      setAccounts(list)
      if (!list?.length) return

      // `?as=gary` signs this tab in without touching any other tab, so two
      // windows can hold two different players at once.
      const as = new URLSearchParams(location.search).get('as')
      if (as && list.includes(as.toLowerCase()) && !isDevSession()) {
        await signInAs(as.toLowerCase(), false)
        const url = new URL(location.href)
        url.searchParams.delete('as')
        location.replace(url.toString())
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!accounts?.length) return null

  return (
    <div className="devbar">
      <span className="devbar__tag">DEV</span>
      <span className="devbar__text">Sign in without a wallet:</span>
      {accounts.map((a) => (
        <button key={a} className="devbar__btn" disabled={busy !== null} onClick={() => void signInAs(a)}>
          {busy === a ? '…' : a}
        </button>
      ))}
      <button
        className="devbar__btn devbar__btn--muted"
        onClick={() => {
          setToken(null)
          location.reload()
        }}
      >
        sign out
      </button>
    </div>
  )
}
