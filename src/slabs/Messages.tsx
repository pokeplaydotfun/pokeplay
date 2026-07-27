import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { getMessages, type Message, type MessageKind } from "./client.ts";
import { ConnectPrompt } from "./Wallet.tsx";
import { Address } from "./Address.tsx";

/**
 * Marketplace inbox.
 *
 * Every message here is derived from a Marketplace contract event and filtered to the
 * connected wallet. Nothing is submitted, stored or accepted from anyone, so there is no
 * write path to attack and a forged message would require forging a chain event.
 *
 * Read state is per wallet in localStorage. Deliberately not server-side: persisting it would
 * need an authenticated write endpoint, which is exactly the attack surface this design
 * avoids, and the cost of losing it is that a message shows as unread again.
 */

const READ_KEY = "pwa:messages:read:v1";

function readIds(address: string): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(READ_KEY) ?? "{}") as Record<string, string[]>;
    return new Set(all[address.toLowerCase()] ?? []);
  } catch {
    return new Set();
  }
}

function markRead(address: string, ids: string[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(READ_KEY) ?? "{}") as Record<string, string[]>;
    const key = address.toLowerCase();
    all[key] = [...new Set([...(all[key] ?? []), ...ids])].slice(-500);
    localStorage.setItem(READ_KEY, JSON.stringify(all));
  } catch {
    /* a full or blocked store must not break the page */
  }
}

const usdg = (base: string | null) =>
  base === null ? "" : (Number(base) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });

const COPY: Record<MessageKind, { title: (m: Message) => string; tone: string; icon: string }> = {
  sold: { title: (m) => `Your card sold for ${usdg(m.amountUsdg)} USDG`, tone: "good", icon: "↗" },
  bought: { title: (m) => `You bought a card for ${usdg(m.amountUsdg)} USDG`, tone: "", icon: "↘" },
  "offer-received": { title: (m) => `New offer of ${usdg(m.amountUsdg)} USDG`, tone: "accent", icon: "◆" },
  "offer-accepted": { title: (m) => `Your offer of ${usdg(m.amountUsdg)} USDG was accepted`, tone: "good", icon: "✓" },
  "offer-withdrawn": { title: () => "An offer was withdrawn", tone: "muted", icon: "×" },
  listed: { title: (m) => `You listed a card for ${usdg(m.amountUsdg)} USDG`, tone: "muted", icon: "•" },
  delisted: { title: () => "You delisted a card", tone: "muted", icon: "•" },
};

export function Messages({ onOpenCard }: { onOpenCard: (tokenId: string) => void }) {
  const { address, isConnected } = useAccount();
  const [messages, setMessages] = useState<Message[]>([]);
  const [read, setRead] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!address) return;
    setLoading(true);
    setRead(readIds(address));
    getMessages(address)
      .then(setMessages)
      .catch(() => setMessages([]))
      .finally(() => setLoading(false));
  }, [address]);

  useEffect(load, [load]);

  // Opening the inbox is the act of reading it, so everything currently shown is marked read
  // on unmount rather than requiring a button nobody would press.
  useEffect(() => {
    return () => {
      if (address && messages.length) markRead(address, messages.map((m) => m.id));
    };
  }, [address, messages]);

  if (!isConnected) {
    return (
      <div className="acct acct-centred">
        <ConnectPrompt title="Connect to see your messages" body="Your inbox follows the wallet holding the cards." />
      </div>
    );
  }

  const unread = messages.filter((m) => !read.has(m.id)).length;

  return (
    <div className="msg">
      <header className="msg-head">
        <h1>Messages</h1>
        <p>
          {loading
            ? "Loading…"
            : messages.length === 0
              ? "Every sale, offer and listing on your cards lands here."
              : `${messages.length} message${messages.length === 1 ? "" : "s"}${unread ? `, ${unread} new` : ""}`}
        </p>
      </header>

      {/* The empty state used to be a line of subtitle text and nothing else, which left the
          page as a heading floating above a footnote. It gets the same panel as a full inbox. */}
      {!loading && messages.length === 0 && (
        <div className="msg-empty">
          <span className="msg-empty-mark" aria-hidden="true">
            ✉
          </span>
          <p>No activity yet.</p>
          <p className="msg-empty-sub">
            Buy or list a card and the first message shows up here.
          </p>
        </div>
      )}

      {messages.length > 0 && (
        <ol className="msg-list">
          {messages.map((m) => {
            const c = COPY[m.kind];
            return (
              <li
                key={m.id}
                className="msg-row"
                data-tone={c.tone || undefined}
                data-unread={!read.has(m.id) || undefined}
                onClick={() => onOpenCard(m.tokenId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenCard(m.tokenId);
                  }
                }}
              >
                <span className="msg-icon" aria-hidden="true">
                  {c.icon}
                </span>
                <span className="msg-body">
                  <span className="msg-title">{c.title(m)}</span>
                  <span className="msg-meta">
                    Card #{m.tokenId}
                    {m.counterparty && (
                      <>
                        {" · "}
                        <Address value={m.counterparty} short />
                      </>
                    )}
                  </span>
                </span>
                {!read.has(m.id) && <span className="msg-dot" aria-label="unread" />}
              </li>
            );
          })}
        </ol>
      )}

    </div>
  );
}

/** Unread count for the nav badge. Cheap enough to call alongside the collection load. */
export async function unreadCount(address: string | undefined): Promise<number> {
  if (!address) return 0;
  try {
    const [messages, seen] = [await getMessages(address), readIds(address)];
    return messages.filter((m) => !seen.has(m.id)).length;
  } catch {
    return 0;
  }
}
