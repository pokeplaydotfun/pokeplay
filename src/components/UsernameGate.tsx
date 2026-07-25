import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSignMessage } from 'wagmi'
import { api, ApiError } from '../lib/api'
import { useSession } from '../lib/session'
import '../styles/username.css'

/**
 * One-time username claim, shown the first time a wallet signs in.
 *
 * The name is signed by the wallet and is permanent — there is no rename
 * endpoint — so this deliberately makes you confirm before committing, and
 * says plainly that the choice is final.
 *
 * Rendered through a portal for the same reason the wallet modal is: an
 * ancestor with a backdrop-filter becomes the containing block for fixed
 * children and the dialog ends up positioned against the header instead of
 * the viewport.
 */

type Availability = { available: boolean; error?: string }

export function UsernameGate() {
  const { me, signedIn, refresh } = useSession()
  const { signMessageAsync } = useSignMessage()

  const [name, setName] = useState('')
  const [status, setStatus] = useState<Availability | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => setMounted(true), [])

  const needed = signedIn && me?.needsUsername === true

  // Live availability, debounced so every keystroke is not a request.
  useEffect(() => {
    if (!needed) return
    const trimmed = name.trim()
    if (!trimmed) {
      setStatus(null)
      return
    }
    setChecking(true)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      try {
        setStatus(await api.get<Availability>(`/api/username/check?name=${encodeURIComponent(trimmed)}`))
      } catch {
        setStatus(null)
      } finally {
        setChecking(false)
      }
    }, 350)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [name, needed])

  const claim = useCallback(async () => {
    const trimmed = name.trim()
    setError(null)
    setBusy(true)
    try {
      // The server issues the exact message; signing anything we composed here
      // would let the two drift apart.
      const { nonce, message } = await api.post<{ nonce: string; message: string }>(
        '/api/username/nonce',
        { name: trimmed },
      )
      const signature = await signMessageAsync({ message })
      await api.post('/api/username', { name: trimmed, nonce, signature })
      await refresh()
    } catch (e) {
      if (e instanceof ApiError) setError(e.message)
      else if ((e as Error).message?.includes('rejected')) setError('Signature cancelled.')
      else setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [name, refresh, signMessageAsync])

  if (!needed || !mounted) return null

  const trimmed = name.trim()
  const ready = status?.available === true && !checking && !busy

  return createPortal(
    <div className="ug" role="dialog" aria-modal="true" aria-labelledby="ug-title">
      <div className="ug__card">
        <h2 className="ug__title" id="ug-title">Choose your username</h2>
        <p className="ug__lede">
          This is the name other players see on the leaderboard and in battle. You sign it
          with your wallet, and <strong>it cannot be changed afterwards</strong>.
        </p>

        <label className="ug__label" htmlFor="ug-name">Username</label>
        <input
          id="ug-name"
          className="ug__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready) void claim()
          }}
          placeholder="ashketchum"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={16}
          autoFocus
        />

        <div className="ug__status">
          {checking && <span className="ug__muted">Checking…</span>}
          {!checking && trimmed && status?.available === true && (
            <span className="ug__ok">✓ {trimmed} is available</span>
          )}
          {!checking && trimmed && status?.available === false && (
            <span className="ug__bad">{status.error ?? 'Not available.'}</span>
          )}
          {!trimmed && (
            <span className="ug__muted">3–16 characters. Letters, numbers and underscores.</span>
          )}
        </div>

        {error && <div className="ug__error">{error}</div>}

        <button className="btn btn--dark ug__go" onClick={() => void claim()} disabled={!ready}>
          {busy ? 'Check your wallet…' : 'Sign and claim'}
        </button>

        <p className="ug__foot">
          Signing costs nothing and sends no transaction. It only proves the wallet is yours.
        </p>
      </div>
    </div>,
    document.body,
  )
}
