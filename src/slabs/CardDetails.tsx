import { displayCardName } from "./cardName.ts";
import { useEffect, useState, type ReactNode } from "react";
import { type CardDetail } from "./client.ts";
import { CONTRACTS, explorerUrl } from "./chain.ts";
import { Address } from "./Address.tsx";

/**
 * Card details, following the shape collectors already know from Collector Crypt's own
 * modal: slab faces on the left with a thumbnail rail, identity and value top right, then
 * collapsible Grading / Vault / Contract sections.
 *
 * Two deliberate departures:
 *
 *  - The Contract section describes OUR side of the mirror (Robinhood Chain and the mirror
 *    token id), not the Solana asset. The Solana mint is still reachable through the
 *    "View on CollectorCrypt" link at the bottom.
 *  - Rows render only when there is a real value behind them. This panel sits under a
 *    "Guaranteed Authenticity" heading, so a placeholder here would undermine the one claim
 *    it exists to make.
 */

const money = (base: string) =>
  `$${(Number(base) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const count = (n: number) => n.toLocaleString("en-US");


function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="cd-row">
      <span className="cd-row-label">{label}</span>
      <span className="cd-row-value">{value}</span>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);

  return (
    <button
      className="cd-copy"
      aria-label={label}
      title={done ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setDone(true));
      }}
    >
      {done ? (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" />
          <path d="M15 5.5A1.5 1.5 0 0013.5 4h-8A1.5 1.5 0 004 5.5v8A1.5 1.5 0 005.5 15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  // Rendered as nothing when every row inside resolved to null, so an empty "Vault" heading
  // never appears.
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="cd-section" data-open={open}>
      <button className="cd-section-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>{title}</span>
        <span className="cd-section-sign" aria-hidden="true">
          {open ? (
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M6 12h12" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M12 6v12M6 12h12" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
          )}
        </span>
      </button>
      {open && <div className="cd-section-body">{children}</div>}
    </div>
  );
}

export function CardDetails({
  card,
  tokenId,
  onClose,
}: {
  card: CardDetail;
  /** The mirror token id, once one exists. Pool cards have not been minted yet. */
  tokenId?: string | null;
  onClose: () => void;
}) {
  const faces = [
    { url: card.imageFront, fallback: card.imageFrontFallback, alt: `${card.name}, front` },
    { url: card.imageBack, fallback: card.imageBackFallback, alt: `${card.name}, back` },
  ].filter((f) => f.url);

  const [face, setFace] = useState(0);
  const active = faces[face] ?? faces[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    // The page behind must not scroll while this is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const hasGrading =
    card.gradingCompany || card.gradingId || card.grade || card.gradePopulation != null ||
    card.totalPopulation != null || card.parallel;
  const hasVault = card.vault || card.vaultId || card.location;

  return (
    <div className="cd-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Card details">
      <div className="cd" onClick={(e) => e.stopPropagation()}>
        <header className="cd-head">
          <h2>Card Details</h2>
          <button className="cd-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="cd-body">
          <div className="cd-media">
            {faces.length > 1 && (
              <div className="cd-thumbs">
                {faces.map((f, i) => (
                  <button
                    key={i}
                    className="cd-thumb"
                    data-active={i === face}
                    onClick={() => setFace(i)}
                    aria-label={f.alt}
                  >
                    <img src={f.url!} alt="" decoding="async" />
                  </button>
                ))}
              </div>
            )}

            <div className="cd-hero">
              {active?.url ? (
                <img
                  src={active.url}
                  alt={active.alt}
                  decoding="async"
                  onError={(e) => {
                    const img = e.currentTarget;
                    if (active.fallback && img.src !== active.fallback) img.src = active.fallback;
                    else img.style.visibility = "hidden";
                  }}
                />
              ) : (
                <div className="cd-hero-blank">No image</div>
              )}
            </div>
          </div>

          <div className="cd-info">
            <span className="cd-authentic">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
                <path d="M8.2 12.2l2.6 2.6 5-5.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Guaranteed Authenticity
            </span>

            <h3 className="cd-title">{displayCardName(card.name)}</h3>

            <div className="cd-value">
              <span className="cd-value-label">Insured Value</span>
              <span className="cd-value-figure">{money(card.insuredValueUsd)}</span>
            </div>

            {hasGrading && (
              <Section title="Grading" defaultOpen>
                <Row label="Grading Company" value={card.gradingCompany} />
                <Row label="Grading ID" value={card.gradingId} />
                <Row label="Grade" value={card.grade} />
                <Row
                  label="Grade Population"
                  value={card.gradePopulation != null ? count(card.gradePopulation) : null}
                />
                <Row
                  label="Total Population"
                  value={card.totalPopulation != null ? count(card.totalPopulation) : null}
                />
                <Row label="Parallel" value={card.parallel} />
                <Row label="Year" value={card.year} />
              </Section>
            )}

            {hasVault && (
              <Section title="Vault">
                <Row label="Vault" value={card.vault} />
                <Row label="Vault ID" value={card.vaultId} />
                <Row label="Location" value={card.location} />
              </Section>
            )}

            <Section title="Contract">
              <div className="cd-row">
                <span className="cd-row-label">Token ID</span>
                <span className="cd-row-value">
                  {tokenId ? (
                    <>
                      {tokenId}
                      <CopyButton text={tokenId} label="Copy token id" />
                    </>
                  ) : (
                    <span className="muted">Not minted yet</span>
                  )}
                </span>
              </div>
              <Row label="Blockchain" value="Robinhood Chain" />
              <div className="cd-row">
                <span className="cd-row-label">Backed by</span>
                <span className="cd-row-value">
                  <Address value={card.mint} short />
                  <CopyButton text={card.mint} label="Copy Solana mint" />
                </span>
              </div>
            </Section>

            {/**
              * Two independent proofs, deliberately side by side.
              *
              * CollectorCrypt shows the physical card and who holds it, so a buyer can confirm
              * it really is sitting in our custody wallet. Blockscout shows the mirror NFT in
              * THEIR wallet. Between them a holder can verify the 1:1 claim without trusting
              * anything we say, which is the whole basis of the product.
              *
              * The chain link only renders once a mirror exists — pool cards have no token id.
              */}
            <div className="cd-externals">
              <a className="cd-external" href={card.ccUrl} target="_blank" rel="noreferrer">
                View on CollectorCrypt
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M8 16L16 8M9.5 8H16v6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
              {tokenId && (
                <a
                  className="cd-external"
                  href={explorerUrl(`token/${CONTRACTS.mirror}/instance/${tokenId}`)}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Robinhood Chain
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M8 16L16 8M9.5 8H16v6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
