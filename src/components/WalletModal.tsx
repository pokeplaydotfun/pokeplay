import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Connector } from 'wagmi'
import { useConnect, useConnectors } from 'wagmi'
import { CHAIN_LABEL } from '../config'

type Entry = {
  key: string
  name: string
  blurb: string
  connector: Connector
  icon?: string
  /** Fallback monogram when the wallet provides no icon. */
  mono: string
}

const svgIcon = (markup: string) => `data:image/svg+xml,${encodeURIComponent(markup)}`

/**
 * SDK-based connectors (Coinbase, WalletConnect) do not advertise an icon the
 * way EIP-6963 extensions do, so we ship their brand marks here.
 */
/** Blue disc with a rounded-square cut-out (evenodd makes the square a hole). */
const COINBASE_ICON = svgIcon(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#0052FF"/><path fill="#fff" fill-rule="evenodd" d="M32 12a20 20 0 1 0 0 40 20 20 0 0 0 0-40Zm-5.6 15.6c0-.66.54-1.2 1.2-1.2h8.8c.66 0 1.2.54 1.2 1.2v8.8c0 .66-.54 1.2-1.2 1.2h-8.8c-.66 0-1.2-.54-1.2-1.2v-8.8Z"/></svg>`,
)

/** Official WalletConnect wordmark path, scaled into a rounded tile. */
const WALLETCONNECT_ICON = svgIcon(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#3B99FC"/><g transform="translate(6.5 16.3) scale(0.17)"><path fill="#fff" d="M61.4385 36.2562C110.349-11.5681 189.651-11.5681 238.562 36.2562L244.448 42.0113C246.893 44.4034 246.893 48.2826 244.448 50.6747L224.311 70.3648C223.089 71.5608 221.107 71.5608 219.884 70.3648L211.784 62.4415C177.672 29.0794 122.328 29.0794 88.2156 62.4415L79.5397 70.9268C78.3169 72.1228 76.3352 72.1228 75.1123 70.9268L54.9754 51.2367C52.5298 48.8446 52.5298 44.9654 54.9754 42.5733L61.4385 36.2562ZM280.206 77.0637L298.128 94.5919C300.573 96.984 300.573 100.863 298.128 103.255L217.317 182.298C214.871 184.69 210.908 184.69 208.463 182.298L151.107 126.198C150.496 125.6 149.504 125.6 148.893 126.198L91.5372 182.298C89.0916 184.69 85.1284 184.69 82.6828 182.298L1.87218 103.255C-0.573294 100.863-0.573294 96.984 1.87218 94.5919L19.7937 77.0637C22.2392 74.6716 26.2024 74.6716 28.6479 77.0637L86.0051 133.164C86.6165 133.762 87.6079 133.762 88.2193 133.164L145.575 77.0637C148.02 74.6716 151.983 74.6716 154.429 77.0637L211.786 133.164C212.397 133.762 213.389 133.762 214 133.164L271.357 77.0637C273.802 74.6716 277.766 74.6716 280.206 77.0637Z"/></g></svg>`,
)

/**
 * Only wallets that are actually available are listed. Extensions announce
 * themselves over EIP-6963, so this reflects what the browser really has.
 * The entries below just give known wallets a nicer blurb, a brand icon and a
 * fixed order — they are skipped entirely when the matching connector is absent.
 */
const KNOWN = [
  {
    key: 'metaMask',
    name: 'MetaMask',
    mono: 'M',
    blurb: 'Browser extension & mobile',
    match: (c: Connector) => /metamask/i.test(c.name) || c.id === 'io.metamask',
  },
  {
    key: 'rabby',
    name: 'Rabby',
    mono: 'R',
    blurb: 'Browser extension',
    match: (c: Connector) => /rabby/i.test(c.name) || c.id === 'io.rabby',
  },
  {
    key: 'coinbase',
    name: 'Coinbase Wallet',
    mono: 'C',
    blurb: 'Extension & smart wallet',
    fallbackIcon: COINBASE_ICON,
    match: (c: Connector) =>
      /coinbase/i.test(c.name) || c.id === 'coinbaseWalletSDK' || c.id === 'coinbaseWallet',
  },
  {
    key: 'walletConnect',
    name: 'WalletConnect',
    mono: 'W',
    blurb: 'Scan with any mobile wallet',
    fallbackIcon: WALLETCONNECT_ICON,
    match: (c: Connector) => c.id === 'walletConnect',
  },
] as const

export function WalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const connectors = useConnectors()
  const { connect, isPending, error, reset } = useConnect()
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  // Resolved after mount, so the portal never renders before `body` exists.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)

  useEffect(() => setPortalTarget(document.body), [])

  // Close on Escape, and lock body scroll while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  useEffect(() => {
    if (open) {
      reset()
      setPendingKey(null)
    }
  }, [open, reset])

  /** Known wallets first, in a fixed order, then anything else detected. */
  const wallets = useMemo(() => {
    const claimed = new Set<string>()

    const known: Entry[] = []
    for (const w of KNOWN) {
      const connector = connectors.find((c) => w.match(c))
      if (!connector) continue
      claimed.add(connector.uid)
      known.push({
        key: w.key,
        name: w.name,
        mono: w.mono,
        blurb: w.blurb,
        connector,
        // EIP-6963 extensions supply their own icon; SDK connectors do not.
        icon: connector.icon ?? ('fallbackIcon' in w ? w.fallbackIcon : undefined),
      })
    }

    const rest: Entry[] = connectors
      .filter((c) => !claimed.has(c.uid) && c.type !== 'mock')
      .map((c) => ({
        key: c.uid,
        name: c.name,
        mono: c.name.slice(0, 1).toUpperCase(),
        blurb: 'Detected in this browser',
        connector: c,
        icon: c.icon,
      }))

    return [...known, ...rest]
  }, [connectors])

  if (!open || !portalTarget) return null

  const choose = (entry: Entry) => {
    setPendingKey(entry.key)
    connect({ connector: entry.connector }, { onSuccess: onClose })
  }

  const renderRow = (entry: Entry) => {
    const busy = isPending && pendingKey === entry.key

    return (
      <button key={entry.key} className="wallet" onClick={() => choose(entry)} disabled={isPending}>
        {entry.icon ? (
          <img className="wallet__icon" src={entry.icon} alt="" />
        ) : (
          <span className="wallet__icon">{entry.mono}</span>
        )}
        <span className="wallet__text">
          <span className="wallet__name">{entry.name}</span>
          <span className="wallet__meta">{busy ? 'Check your wallet…' : entry.blurb}</span>
        </span>
        <span className="wallet__tag wallet__tag--installed">{busy ? '…' : 'Detected'}</span>
      </button>
    )
  }

  /*
   * Rendered through a portal: the sticky header sets `backdrop-filter`, which
   * makes it a containing block for fixed-position descendants. Left in place,
   * the overlay would centre itself on the header instead of the viewport.
   */
  return createPortal(
    <div
      className="modal__backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="presentation"
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="Connect a wallet">
        <div className="modal__head">
          <div>
            <div className="modal__title">Connect a wallet</div>
            <div className="modal__sub">Choose how you want to connect to {CHAIN_LABEL}.</div>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error && <div className="modal__error">{error.message}</div>}

        <div className="modal__list">
          {wallets.length > 0 ? (
            wallets.map(renderRow)
          ) : (
            <div className="modal__none">
              <div className="modal__none-title">No wallets detected</div>
              <div className="modal__none-body">
                Install a browser wallet such as MetaMask, Rabby or Coinbase Wallet, then reload this
                page.
              </div>
            </div>
          )}
        </div>

        <div className="modal__foot">
          Connecting is free and does not move any funds.
        </div>
      </div>
    </div>,
    portalTarget,
  )
}
