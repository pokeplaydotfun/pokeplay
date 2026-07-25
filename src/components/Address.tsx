import { useCallback, useEffect, useRef, useState } from 'react'
import { shortAddr } from '../lib/api'
import '../styles/address.css'

/**
 * Any 0x address, always copyable.
 *
 * Every address on the site goes through here — player wallets, contracts,
 * opponents — so the behaviour is identical wherever one appears. Addresses are
 * shown truncated because the full 42 characters are unreadable, which makes
 * copying by hand impossible: without this, a truncated address is worse than
 * useless to someone who needs the real thing.
 *
 * The clipboard API needs a secure context and can be refused, so there is a
 * fallback, and the title always carries the full value as a last resort.
 */
export function Address({
  value,
  label,
  full = false,
  className = '',
}: {
  value: string
  /** Overrides the displayed text; the full address is still what gets copied. */
  label?: string
  /** Show every character rather than the truncated form. */
  full?: boolean
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const copy = useCallback(async () => {
    const ok = await writeClipboard(value)
    if (!ok) return
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1600)
  }, [value])

  const shown = label ?? (full ? value : shortAddr(value))

  return (
    <button
      type="button"
      className={`addr${copied ? ' addr--copied' : ''} ${className}`.trim()}
      onClick={(e) => {
        // Addresses often sit inside clickable rows or links.
        e.stopPropagation()
        e.preventDefault()
        void copy()
      }}
      title={copied ? 'Copied' : `Copy ${value}`}
      aria-label={copied ? `Copied ${value}` : `Copy address ${value}`}
    >
      <span className="addr__text">{shown}</span>
      <span className="addr__icon" aria-hidden="true">
        {copied ? '✓' : '⧉'}
      </span>
    </button>
  )
}

/** Clipboard write with a fallback for insecure contexts and older browsers. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission denied or not a secure context — fall through.
  }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    // Keep it out of view without making it unselectable.
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
