import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccount, useBalance, useDisconnect, useSwitchChain } from 'wagmi'
import { formatEther } from 'viem'
import { useSession } from '../lib/session'
import { shortAddr } from '../lib/api'
import { CHAIN_ID, CHAIN_LABEL, CURRENCY } from '../config'
import { WalletModal } from './WalletModal'
import { Address } from './Address'

/** The Ethereum mark — the native currency on Robinhood Chain is ETH. */
function EthIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      className="eth-icon"
      viewBox="0 0 256 417"
      width={size}
      height={size}
      aria-hidden="true"
      preserveAspectRatio="xMidYMid"
    >
      <path fill="#343434" d="M127.961 0l-2.795 9.5v275.668l2.795 2.79 127.962-75.638z" />
      <path fill="#8C8C8C" d="M127.962 0L0 212.32l127.962 75.639V154.158z" />
      <path fill="#3C3C3B" d="M127.961 312.187l-1.575 1.92v98.199l1.575 4.601L256 236.587z" />
      <path fill="#8C8C8C" d="M127.962 416.905v-104.72L0 236.585z" />
      <path fill="#141414" d="M127.961 287.958l127.96-75.637-127.96-58.162z" />
      <path fill="#393939" d="M0 212.32l127.96 75.638V154.159z" />
    </svg>
  )
}

/** Trim an ETH amount to a clean, short display (up to 4 decimals). */
function fmtEth(value: bigint): string {
  return Number(formatEther(value)).toLocaleString(undefined, {
    maximumFractionDigits: 4,
  })
}

/**
 * A deterministic little identicon so an address is recognisable at a glance.
 * Derived from the address itself — same wallet, same colours, every time.
 */
function Avatar({ address, size = 26 }: { address: string; size?: number }) {
  const n = parseInt(address.slice(2, 10), 16)
  const hue = n % 360
  const hue2 = (hue + 60 + (n % 90)) % 360
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${hue} 70% 58%), hsl(${hue2} 70% 46%))`,
      }}
      aria-hidden="true"
    />
  )
}

export function AccountMenu() {
  const [walletOpen, setWalletOpen] = useState(false)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const { address, isConnected, chainId } = useAccount()
  const { disconnect } = useDisconnect()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { me, signedIn, signingIn, signIn, signOut } = useSession()
  const { data: balance } = useBalance({ address, chainId: CHAIN_ID })

  const wrongNetwork = isConnected && chainId !== undefined && chainId !== CHAIN_ID

  // Close on outside click or Escape — a dropdown that traps you is worse
  // than no dropdown.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!isConnected || !address) {
    return (
      <>
        <button className="btn btn--dark" onClick={() => setWalletOpen(true)}>
          Connect
        </button>
        <WalletModal open={walletOpen} onClose={() => setWalletOpen(false)} />
      </>
    )
  }

  if (wrongNetwork) {
    return (
      <button
        className="wrong-net"
        onClick={() => switchChain({ chainId: CHAIN_ID })}
        disabled={switching}
      >
        {switching ? 'Switching…' : `Switch to ${CHAIN_LABEL}`}
      </button>
    )
  }

  // Connected but no session yet (e.g. the sign-in signature was dismissed).
  // Show a clear way to complete it rather than the raw address, which would
  // look signed-in when it is not.
  if (!signedIn) {
    return (
      <button className="btn btn--dark" onClick={() => void signIn()} disabled={signingIn}>
        {signingIn ? 'Check your wallet…' : 'Sign in'}
      </button>
    )
  }

  const label = me?.name ?? shortAddr(address)

  return (
    <div className="acct" ref={wrapRef}>
      <button
        className={`acct__trigger${open ? ' acct__trigger--open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Avatar address={address} />
        <span className="acct__label">{label}</span>
        <svg className="acct__caret" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="acct__menu" role="menu">
          <div className="acct__head">
            <Avatar address={address} size={34} />
            <div className="acct__ident">
              <div className="acct__name">{me?.name ?? 'Trainer'}</div>
              <Address value={address} className="acct__addr" />
            </div>
          </div>

          <div className="acct__balance">
            <span className="acct__balance-chain">{CHAIN_LABEL} balance</span>
            <span className="acct__balance-amt">
              <EthIcon />
              {balance ? fmtEth(balance.value) : '—'} {CURRENCY}
            </span>
          </div>

          <div className="acct__items">
            <Link className="acct__item" to="/profile" role="menuitem" onClick={() => setOpen(false)}>
              <span className="acct__icon">◎</span> Profile
            </Link>

            {/* Disconnecting also ends the session, so this is the single, clean
                way out — a separate "Sign out" that left the wallet connected
                only re-signed you in on the next action. */}
            <button
              className="acct__item acct__item--muted"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                void signOut()
                disconnect()
              }}
            >
              <span className="acct__icon">⏻</span> Disconnect wallet
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
