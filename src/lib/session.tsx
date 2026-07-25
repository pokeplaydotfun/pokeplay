import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { api, getToken, isDevSession, setToken, type Me } from './api'

type Session = {
  me: Me | null
  address: `0x${string}` | undefined
  isConnected: boolean
  signedIn: boolean
  signingIn: boolean
  error: string | null
  signIn: () => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const SessionContext = createContext<Session | null>(null)

/**
 * One session shared by the whole app.
 *
 * This has to be a provider rather than a plain hook: a hook holding `useState`
 * gives every caller its own copy, so signing in from the header left the other
 * panels still believing they were signed out — and each one asked the user to
 * sign again. One instance, one signature, everywhere.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { address, isConnected } = useAccount()
  const { signMessageAsync } = useSignMessage()

  const [me, setMe] = useState<Me | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!getToken()) return setMe(null)
    try {
      setMe(await api.get<Me>('/api/me'))
    } catch {
      setMe(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A session belongs to one address; switching or disconnecting drops it.
  // Dev sessions have no wallet behind them, so they are exempt.
  useEffect(() => {
    if (isDevSession()) return
    if (me && address && me.address.toLowerCase() !== address.toLowerCase()) {
      setToken(null)
      setMe(null)
    }
    if (!isConnected && me) {
      setToken(null)
      setMe(null)
    }
  }, [address, isConnected, me])

  /**
   * Connecting a wallet and signing in are one step, not two.
   *
   * Without this, connecting only proves the wallet is present — it does not
   * create a session, so the header shows the raw address, play/profile stay
   * locked, and a first-time player never gets the username prompt. Signing in
   * the moment a fresh wallet connects makes the whole thing a single flow:
   * connect → one signature → (first time) pick a username → everything works.
   *
   * `autoSignedFor` guards against re-prompting: if the user rejects the
   * signature we do not loop, and a wallet that already holds a valid session
   * (has a token) is left alone.
   */
  const autoSignedFor = useRef<string | null>(null)
  useEffect(() => {
    if (isDevSession()) return
    if (!isConnected || !address) {
      autoSignedFor.current = null
      return
    }
    if (!getToken() && !signingIn && !me && autoSignedFor.current !== address) {
      autoSignedFor.current = address
      void signIn()
    }
    // signIn is stable enough; including it would re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address, signingIn, me])

  const signIn = useCallback(async () => {
    if (!address) return
    setSigningIn(true)
    setError(null)
    try {
      const { nonce, message } = await api.post<{ nonce: string; message: string }>(
        '/api/auth/nonce',
        { address },
      )
      const signature = await signMessageAsync({ message })
      const { token } = await api.post<{ token: string }>('/api/auth/verify', {
        address,
        nonce,
        signature,
      })
      setToken(token)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSigningIn(false)
    }
  }, [address, signMessageAsync, refresh])

  const signOut = useCallback(async () => {
    try {
      await api.post('/api/auth/logout')
    } catch {
      // Dropping the local token is what actually matters.
    }
    setToken(null)
    setMe(null)
  }, [])

  const value = useMemo<Session>(
    () => ({
      me,
      address,
      isConnected,
      signedIn: Boolean(me),
      signingIn,
      error,
      signIn,
      signOut,
      refresh,
    }),
    [me, address, isConnected, signingIn, error, signIn, signOut, refresh],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): Session {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}
