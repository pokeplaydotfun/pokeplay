import { useEffect, useId, useRef, useState } from 'react'

/**
 * One selectable trait — a nature or an ability.
 *
 * `hint` is the compact right-hand tag shown in the row (e.g. "+Atk −SpA" or
 * "hidden"); `desc` is the full plain-English explanation revealed in the panel
 * footer when the row is hovered or focused. `flag` is an optional caveat
 * appended in the accent colour (used for abilities that are inert here).
 */
export type TraitOption = {
  value: string
  label: string
  hint?: string
  desc: string
  flag?: string | null
}

type Props = {
  /** Accessible label for the control. */
  label: string
  value: string | undefined
  options: TraitOption[]
  onChange: (value: string) => void
  disabled?: boolean
  /** Shown on the trigger when nothing is selected / no options exist. */
  placeholder?: string
}

/**
 * A custom dropdown that does what a native <select> cannot: explain each
 * choice. Hovering (or keyboard-focusing) an option reveals a sentence of
 * what it does in the panel footer, so a player picking a nature or an ability
 * learns the effect without leaving the builder.
 *
 * Kept deliberately small: the trigger toggles a panel, options are real
 * buttons (so Tab moves through them and focus drives the footer), and the
 * panel closes on outside-click or Escape. Selecting returns focus to the
 * trigger.
 */
export function TraitSelect({ label, value, options, onChange, disabled, placeholder }: Props) {
  const [open, setOpen] = useState(false)
  // Which option's description is showing in the footer. Defaults to the
  // selected one so the footer is never empty while the panel is open.
  const [previewed, setPreviewed] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  const selected = options.find((o) => o.value === value) ?? null
  const footer =
    options.find((o) => o.value === (previewed ?? value)) ?? selected ?? null

  // Close when the pointer goes elsewhere, or on Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Reset the previewed row to the current selection whenever the panel opens.
  useEffect(() => {
    if (open) setPreviewed(value ?? null)
  }, [open, value])

  const choose = (v: string) => {
    onChange(v)
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div className={`tsel${open ? ' tsel--open' : ''}`} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="tsel__trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tsel__value">
          {selected ? (
            <>
              <span className="tsel__value-label">{selected.label}</span>
              {selected.hint && <span className="tsel__value-hint">{selected.hint}</span>}
            </>
          ) : (
            <span className="tsel__value-placeholder">{placeholder ?? 'Select…'}</span>
          )}
        </span>
        <svg className="tsel__caret" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="tsel__panel" id={panelId} role="listbox" aria-label={label}>
          <div className="tsel__list">
            {options.map((o) => {
              const isSel = o.value === value
              return (
                <button
                  type="button"
                  key={o.value}
                  role="option"
                  aria-selected={isSel}
                  className={`tsel__opt${isSel ? ' tsel__opt--sel' : ''}`}
                  onMouseEnter={() => setPreviewed(o.value)}
                  onFocus={() => setPreviewed(o.value)}
                  onClick={() => choose(o.value)}
                >
                  <span className="tsel__opt-label">{o.label}</span>
                  {o.hint && <span className="tsel__opt-hint">{o.hint}</span>}
                  {isSel && (
                    <svg className="tsel__opt-check" viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M2.5 6.5 5 9l4.5-5.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              )
            })}
          </div>
          <div className="tsel__desc" aria-live="polite">
            {footer ? (
              <>
                <span className="tsel__desc-name">{footer.label}</span>
                <span className="tsel__desc-text">
                  {footer.desc}
                  {footer.flag && <span className="tsel__desc-flag"> {footer.flag}</span>}
                </span>
              </>
            ) : (
              <span className="tsel__desc-text">Hover an option to see what it does.</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
