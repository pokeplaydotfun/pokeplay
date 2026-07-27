import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  useAccount,
  useChainId,
  useConnect,
  useConnectors,
  useDisconnect,
  useSwitchChain,
  useReadContract,
} from "wagmi";
import type { Connector } from "wagmi";
import { CONTRACTS, hasInjectedWallet, robinhoodChain } from "./chain.ts";
import { ERC20_ABI } from "./abis.ts";
import usdgIcon from "/slabs/usdg.png";

const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

/**
 * The wallets we can actually offer.
 *
 * `useConnectors` returns every EIP-6963 provider that announced itself, plus our generic
 * `injected` fallback. When real providers are discovered the generic one is dropped: it
 * points at whichever extension won the `window.ethereum` race, so leaving it in the list
 * shows a duplicate entry that opens an arbitrary wallet.
 */
function useWalletChoices(): readonly Connector[] {
  const connectors = useConnectors();
  const [okxPresent, setOkxPresent] = useState(false);

  /**
   * Is OKX actually installed? Checked at runtime, not assumed.
   *
   * The OKX connector is declared unconditionally in the config, so without this it would be
   * offered to everyone — and picking a wallet you do not have produces a click that does
   * nothing, which is the failure this whole area is about.
   */
  useEffect(() => {
    setOkxPresent(typeof window !== "undefined" && Boolean((window as { okxwallet?: unknown }).okxwallet));
  }, []);

  const usable = connectors.filter((c) => (c.id === "okxWallet" ? okxPresent : true));

  /**
   * Prefer wallets that announced themselves, but never at the cost of hiding OKX: it is
   * reachable through its own provider whether or not it announces, and dropping it here was
   * how a user with only OKX ended up with an empty picker.
   *
   * Deduped by name, because OKX appears twice when it DOES announce — once from discovery and
   * once from the explicit target — and two identical rows is its own kind of broken.
   */
  const announced = usable.filter((c) => c.id !== "injected");
  const chosen = announced.length > 0 ? announced : usable;

  /**
   * Deduped by name, keeping the entry that HAS an icon.
   *
   * OKX appears twice when it announces itself: once from discovery, once from the explicit
   * target. Either can connect, but the announced one carries the wallet's own artwork, so
   * preferring an entry with an icon means the picker shows the real logo when it is available
   * and our drawn fallback only when it is not.
   */
  const byName = new Map<string, Connector>();
  for (const c of chosen) {
    const key = c.name.toLowerCase().replace(/\s+/g, "");
    const existing = byName.get(key);
    if (!existing || (!existing.icon && c.icon)) byName.set(key, c);
  }
  return [...byName.values()];
}

function WalletPicker({
  choices,
  onPick,
  onClose,
  pending,
  error,
}: {
  choices: readonly Connector[];
  onPick: (c: Connector) => void;
  onClose: () => void;
  pending: boolean;
  error: string | null;
}) {
  // Escape closes, as with any modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /*
   * Portalled to <body> deliberately. The button lives inside the sticky nav, which has a
   * backdrop-filter — and a filtered ancestor becomes the containing block for
   * position:fixed descendants. Rendered in place, this modal gets trapped inside the
   * 65px-tall header instead of covering the viewport.
   */
  return createPortal(
    <div className="stage picker-backdrop" onClick={onClose}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <h2>Connect a wallet</h2>
          <button className="picker-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="picker-list">
          {choices.map((c) => (
            <button key={c.uid} className="picker-item" disabled={pending} onClick={() => onPick(c)}>
              {c.icon ? (
                <img className="picker-icon" src={c.icon} alt="" />
              ) : (
                <span className="picker-icon picker-icon-blank">{c.name.slice(0, 1)}</span>
              )}
              <span className="picker-name">{c.name}</span>
              <span className="picker-go">›</span>
            </button>
          ))}
        </div>

        {pending && <div className="picker-note">Check your wallet to approve the connection…</div>}
        {error && <div className="picker-note picker-error">{error}</div>}

        <div className="picker-foot">
          We never see your keys. Connecting only shares your public address.
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A stable colour pair derived from the address, so each account has its own mark. */
function addressGradient(addr: string): string {
  let h = 0;
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) % 360;
  return `linear-gradient(140deg, hsl(${h} 68% 56%), hsl(${(h + 48) % 360} 62% 42%))`;
}

type MenuAction = {
  key: string;
  label: string;
  icon: string;
  soon?: boolean;
  keepOpen?: boolean;
  onClick?: () => void;
  /** Unread count. Rendered as a dot on the avatar and a number on the row. */
  badge?: number;
};

function AccountMenu({
  address,
  balance,
  onClose,
  onProfile,
  onSettings,
  onWithdraw,
  onMessages,
  onDeposit,
  onTransfer,
  onDisconnect,
  unread = 0,
}: {
  address: `0x${string}`;
  balance: bigint | undefined;
  onClose: () => void;
  onProfile: () => void;
  onSettings: () => void;
  onWithdraw: () => void;
  onMessages: () => void;
  onDeposit: () => void;
  onTransfer: () => void;
  /** Unread marketplace messages, for the dot and the row badge. */
  unread?: number;
  onDisconnect: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Deferred so the click that opened the menu doesn't immediately close it.
    const t = setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      clearTimeout(t);
    };
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard can be blocked; the address is visible either way */
    }
  };

  /*
   * Items that do nothing yet are marked "Soon" rather than rendered as live buttons.
   * A menu entry that looks clickable and silently does nothing is worse than an honest
   * label — especially in a wallet menu, where people are already wary.
   */
  const actions: MenuAction[] = [
    { key: "profile", label: "Profile", icon: "◈", onClick: onProfile },
    { key: "messages", label: "Messages", icon: "✉", onClick: onMessages, badge: unread },
    { key: "settings", label: "Settings", icon: "⚙", onClick: onSettings },
    // "Withdraw", not "Swap": nothing is being exchanged. The mirror is destroyed and the
    // real card leaves custody, which is a one-way move and should read like one.
    { key: "withdraw", label: "Withdraw", icon: "↗", onClick: onWithdraw },
    // Deposit sits under Withdraw because they are the same door in opposite directions:
    // one sends a card out of the vault, the other brings one in.
    { key: "deposit", label: "Deposit", icon: "↙", onClick: onDeposit },
    { key: "transfer", label: "Transfer cards", icon: "⇄", onClick: onTransfer },
  ];

  return (
    <div className="account-menu" ref={ref}>
      <div className="account-head">
        <span className="account-avatar" style={{ background: addressGradient(address) }} />
        <div className="account-id">
          <button className="account-addr" onClick={copy} title="Copy address">
            {short(address)}
            <span className="account-copy">{copied ? "copied" : "copy"}</span>
          </button>
          <div className="account-network">Robinhood Chain</div>
        </div>
      </div>

      <div className="account-balance-row">
        <span className="account-balance-label">Balance</span>
        <span className="account-balance-value">
          {balance === undefined ? (
            <span className="account-balance-pending">0.00</span>
          ) : (
            <>
              {(Number(balance) / 1e6).toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
              <span className="account-balance-unit">USDG</span>
            </>
          )}
        </span>
      </div>

      <div className="account-actions">
        {actions.map((a) => (
          <button
            key={a.key}
            className="account-item"
            disabled={a.soon}
            onClick={() => {
              a.onClick?.();
              // Adding the token keeps the menu open so the confirmation is visible.
              if (!a.keepOpen) onClose();
            }}
          >
            <span className="account-icon">{a.icon}</span>
            <span className="account-label">{a.label}</span>
            {a.badge ? <span className="account-badge">{a.badge > 99 ? "99+" : a.badge}</span> : null}
            {a.soon && <span className="account-soon">Soon</span>}
          </button>
        ))}

      </div>

      <div className="account-foot">
        <button
          className="account-item danger"
          onClick={() => {
            onDisconnect();
            onClose();
          }}
        >
          <span className="account-icon">⏻</span>
          <span className="account-label">Log out</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Connect button + network guard (doc 05 §5).
 *
 *   not connected  -> pick a wallet (or connect straight through if only one exists)
 *   wrong network  -> switch to Robinhood Chain, one click
 *   connected      -> address + USDG balance
 */
export function WalletButton({
  onProfile,
  onSettings,
  onWithdraw,
  onMessages,
  onDeposit,
  onTransfer,
  unread = 0,
}: {
  onProfile?: () => void;
  onSettings?: () => void;
  onWithdraw?: () => void;
  onMessages?: () => void;
  onDeposit?: () => void;
  onTransfer?: () => void;
  /** Unread marketplace messages. Surfaced on the closed wallet button, not only inside. */
  unread?: number;
} = {}) {
  const { address, isConnected, connector: activeConnector } = useAccount();
  const chainId = useChainId();
  const { connect, isPending, error, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const [addError, setAddError] = useState<string | null>(null);
  const choices = useWalletChoices();
  const [picking, setPicking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // USDG is 6dp (verified on-chain, T5), so format against 1e6 rather than assuming 18.
  const { data: usdgBalance } = useReadContract({
    address: CONTRACTS.usdg,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: robinhoodChain.id,
    query: { enabled: Boolean(address && CONTRACTS.usdg) },
  });

  useEffect(() => {
    if (isConnected) setPicking(false);
    else setMenuOpen(false);
  }, [isConnected]);

  const wrongNetwork = isConnected && chainId !== robinhoodChain.id;

  if (!hasInjectedWallet() && choices.length === 0) {
    return (
      <a className="wallet-cta ghost-link" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
        Install a wallet
      </a>
    );
  }

  if (!isConnected) {
    const openOrConnect = () => {
      reset();
      // One wallet installed is not a choice — going straight through saves a pointless
      // click. Two or more and the user picks.
      if (choices.length === 1 && choices[0]) connect({ connector: choices[0] });
      else setPicking(true);
    };

    return (
      <div className="wallet-wrap">
        <button className="wallet-cta" disabled={isPending && !picking} onClick={openOrConnect}>
          {isPending && !picking ? (
            "Check your wallet…"
          ) : (
            <>
              {/*
                "Connect wallet" does not fit a 390px nav alongside the brand and three
                nav groups — measured 453px of content in a 390px bar, so the button was
                clipped at the right edge. Two spans rather than a JS width check: the
                label switches at the same breakpoint as the rest of the nav, with no
                resize listener and no flash of the wrong text on first paint.
              */}
              <span className="wallet-cta-full">Connect wallet</span>
              <span className="wallet-cta-short">Connect</span>
            </>
          )}
        </button>

        {/**
          * The connect error, shown OUTSIDE the picker too.
          *
          * With a single wallet installed the picker never opens — the click connects straight
          * through — so this error had nowhere to render. Anyone whose wallet refused, was
          * locked, or errored saw a button that simply did nothing, which is indistinguishable
          * from the site being broken. A rejected prompt is not shown, because that is a normal
          * outcome the user just chose.
          */}
        {!picking && error && !/user rejected|denied|closed/i.test(error.message) && (
          <p className="wallet-connect-error">{error.message.split("\n")[0]!.slice(0, 140)}</p>
        )}

        {picking && (
          <WalletPicker
            choices={choices}
            pending={isPending}
            error={error ? error.message.split("\n")[0]! : null}
            onPick={(c) => {
              reset();
              connect({ connector: c });
            }}
            onClose={() => {
              reset();
              setPicking(false);
            }}
          />
        )}
      </div>
    );
  }

  if (wrongNetwork) {
    /**
     * Switch, and ADD the chain if the wallet has never seen it.
     *
     * wagmi's switchChain sends `wallet_switchEthereumChain`, which a wallet answers with 4902
     * when the chain is unknown to it. Some wallets — OKX among them — do not then add it on
     * their own, so the click appeared to do nothing at all: no prompt, no error, because the
     * hook's `error` was never read. That is indistinguishable from the site being broken.
     *
     * So the failure is surfaced, and an unknown chain is added explicitly from the same
     * verified values the app uses everywhere else rather than left to the wallet to guess.
     */
    const switchOrAdd = async () => {
      setAddError(null);
      try {
        await switchChain({ chainId: robinhoodChain.id });
      } catch (err) {
        const code = (err as { code?: number })?.code;
        const message = err instanceof Error ? err.message : String(err);
        const unknownChain = code === 4902 || /unrecognized|not been added|unknown chain/i.test(message);

        if (!unknownChain) {
          setAddError(/user rejected|denied/i.test(message) ? null : message.split("\n")[0]!.slice(0, 140));
          return;
        }

        try {
          const provider = (await activeConnector?.getProvider?.()) as
            | { request(a: { method: string; params?: unknown[] }): Promise<unknown> }
            | undefined;
          if (!provider) throw new Error("No wallet provider available.");
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: `0x${robinhoodChain.id.toString(16)}`,
                chainName: robinhoodChain.name,
                nativeCurrency: robinhoodChain.nativeCurrency,
                rpcUrls: [...robinhoodChain.rpcUrls.default.http],
                blockExplorerUrls: [robinhoodChain.blockExplorers!.default.url],
              },
            ],
          });
        } catch (addErr) {
          const m = addErr instanceof Error ? addErr.message : String(addErr);
          if (!/user rejected|denied/i.test(m)) setAddError(m.split("\n")[0]!.slice(0, 140));
        }
      }
    };

    return (
      <div className="wallet-switch">
        <button className="wallet-cta warn" disabled={switching} onClick={() => void switchOrAdd()}>
          {switching ? "Confirm in wallet…" : "Switch to Robinhood Chain"}
        </button>
        {(addError || switchError) && (
          <p className="wallet-switch-error">
            {addError ?? switchError?.message.split("\n")[0]?.slice(0, 140)}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="wallet-wrap">
      {/*
        Balance and account are two things, so they are two controls: a read-only balance
        pill, and a round account button that opens the menu.

        They used to be one wide button carrying a dot, a truncated address, a balance and
        a caret — four pieces of information in a control whose only job was to open a
        menu, and the address was the least useful of them. The balance is what someone
        checks constantly; the address is already inside the menu, next to the copy button
        that makes it useful.
      */}
      <span className="wallet-balance" title="USDG balance">
        <img className="usdg-mark" src={usdgIcon} alt="" />
        {usdgBalance === undefined
          ? "0"
          : (Number(usdgBalance) / 1e6).toLocaleString("en-US", {
              minimumFractionDigits: 0,
              maximumFractionDigits: 2,
            })}
      </span>

      <button
        className="wallet-account"
        data-open={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
        aria-expanded={menuOpen}
        aria-label="Account menu"
        title={short(address!)}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="12" cy="9.6" r="3.1" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M5.9 19.4a6.6 6.6 0 0 1 12.2 0"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
        {/* A dot on the closed button, because a badge only inside the menu is a badge
            nobody sees. Deliberately not a number: the count belongs on the row it
            describes, and a bare dot reads as "something is waiting" without shouting. */}
        {unread > 0 && <span className="wallet-unread" aria-label={`${unread} unread messages`} />}
      </button>

      {menuOpen && (
        <AccountMenu
          address={address!}
          balance={usdgBalance as bigint | undefined}
          onClose={() => setMenuOpen(false)}
          onProfile={() => onProfile?.()}
          onSettings={() => onSettings?.()}
          onWithdraw={() => onWithdraw?.()}
          onMessages={() => onMessages?.()}
          onDeposit={() => onDeposit?.()}
          onTransfer={() => onTransfer?.()}
          unread={unread}
          onDisconnect={() => disconnect()}
        />
      )}
    </div>
  );
}

/**
 * Banner shown when the wallet is on the wrong chain. Deliberately separate from the button:
 * a user mid-rip needs the explanation, not just a control in the corner.
 */
export function NetworkGuard() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected || chainId === robinhoodChain.id) return null;

  return (
    <div className="guard-banner">
      <div>
        <b>Wrong network.</b> This runs on Robinhood Chain (id {robinhoodChain.id}). Your
        wallet is on chain {chainId}.
      </div>
      <button className="wallet-cta warn" disabled={isPending} onClick={() => switchChain({ chainId: robinhoodChain.id })}>
        {isPending ? "Confirm in wallet…" : "Switch network"}
      </button>
    </div>
  );
}


/**
 * Shared "you need a wallet first" state.
 *
 * Used both by the empty collection and by any attempt to open a pack while disconnected,
 * so the answer to "why can't I do this?" looks the same wherever you meet it. It owns its
 * own picker, so a caller only has to render it.
 */
export function ConnectPrompt({
  title = "Connect your wallet",
  body = "Connect a wallet to open packs and see your collection.",
}: {
  title?: string;
  body?: string;
}) {
  const { connect, isPending, error, reset } = useConnect();
  const choices = useWalletChoices();
  const [picking, setPicking] = useState(false);

  const start = () => {
    reset();
    if (choices.length === 1 && choices[0]) connect({ connector: choices[0] });
    else setPicking(true);
  };

  return (
    <div className="connect-prompt">
      <span className="connect-prompt-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <rect x="2.8" y="5.6" width="18.4" height="13.2" rx="3.2" stroke="currentColor" strokeWidth="1.6" />
          <path d="M2.8 9.6h18.4" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="16.9" cy="14.2" r="1.5" fill="currentColor" />
        </svg>
      </span>

      <h3 className="connect-prompt-title">{title}</h3>
      <p className="connect-prompt-body">{body}</p>

      <button className="primary" disabled={isPending && !picking} onClick={start}>
        {isPending && !picking ? (
            "Check your wallet…"
          ) : (
            <>
              {/*
                "Connect wallet" does not fit a 390px nav alongside the brand and three
                nav groups — measured 453px of content in a 390px bar, so the button was
                clipped at the right edge. Two spans rather than a JS width check: the
                label switches at the same breakpoint as the rest of the nav, with no
                resize listener and no flash of the wrong text on first paint.
              */}
              <span className="wallet-cta-full">Connect wallet</span>
              <span className="wallet-cta-short">Connect</span>
            </>
          )}
      </button>

      {!hasInjectedWallet() && choices.length === 0 && (
        <a className="connect-prompt-help" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
          Don't have one? Get a wallet →
        </a>
      )}

      {picking && (
        <WalletPicker
          choices={choices}
          pending={isPending}
          error={error ? error.message.split("\n")[0]! : null}
          onPick={(c) => {
            reset();
            connect({ connector: c });
          }}
          onClose={() => {
            reset();
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}
