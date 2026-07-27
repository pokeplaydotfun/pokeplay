import { useEffect, useState } from "react";

/**
 * The single way an address is rendered anywhere on this site.
 *
 * Every wallet, contract and mint address goes through here, so copying always works the
 * same way and nobody has to select 44 characters of base58 by hand. Use it rather than
 * printing an address into a <code> block.
 *
 * Addresses are shown in full by default. Truncation is opt-in, because a truncated address
 * that cannot be expanded is useless for the one thing people want it for: checking that it
 * matches something else.
 */
export function Address({
  value,
  short,
  label,
  className,
  href,
}: {
  value: string;
  /** Show as 0x1234…abcd. The copy still yields the full value. */
  short?: boolean;
  /** Small caption above the address. */
  label?: string;
  className?: string;
  /** Makes the address itself a link, usually to an explorer. */
  href?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const display =
    short && value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard can be blocked by permissions or a non-secure origin. The address is
      // selectable either way, so this is not worth surfacing as an error.
    }
  };

  return (
    <span className={`addr${className ? ` ${className}` : ""}`}>
      {label && <span className="addr-label">{label}</span>}
      <span className="addr-row">
        {href ? (
          <a className="addr-value" href={href} target="_blank" rel="noreferrer" title={value}>
            {display}
          </a>
        ) : (
          /*
            The address itself copies, not just the icon beside it.

            A 26px icon is a small target for the single most common action on an address,
            and people try clicking the address first — it is the thing they came for. The
            icon stays, because a click target with no affordance is invisible.

            A button, not a <code> with onClick: it is focusable, reachable by keyboard and
            announced as a control, none of which a clickable <code> would be.
          */
          <button
            type="button"
            className="addr-value addr-value-copy"
            onClick={copy}
            title={copied ? "Copied" : `${value} — click to copy`}
            aria-label={copied ? "Copied" : `Copy ${label ?? "address"}`}
          >
            {display}
          </button>
        )}
        <button
          className="addr-copy"
          onClick={copy}
          aria-label={copied ? "Copied" : `Copy ${label ?? "address"}`}
          title={copied ? "Copied" : "Copy"}
          data-copied={copied}
        >
          {copied ? (
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" />
              <path d="M15 5.5A1.5 1.5 0 0013.5 4h-8A1.5 1.5 0 004 5.5v8A1.5 1.5 0 005.5 15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </span>
    </span>
  );
}
