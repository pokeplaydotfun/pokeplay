import { useEffect, useState } from "react";
import { machineLabel, type Machine } from "./client.ts";
import { Address } from "./Address.tsx";
import { CONTRACTS, collectionUrl, robinhoodChain } from "./chain.ts";
import { MIRROR_NFT_ABI } from "./abis.ts";
import { readContract } from "wagmi/actions";
import { useConfig } from "wagmi";
import { BRAND_NAME, BRAND_FULL } from "./brand.ts";

/**
 * The Solana wallet holding the Collector Crypt cards that back every mirror.
 *
 * Published deliberately: the proof-of-reserves claim beside it only means something if it
 * can be checked. Note this is currently ALSO the worker's hot signing key. Splitting
 * custody from the signer is a planned change, and when it happens this should point at the
 * receive-only custody wallet instead of the signer.
 */

/**
 * The explainer page. Every number is derived from a live machine, and the pack selector
 * drives BOTH the odds table and the pricing panel: odds, value bands, price and buyback
 * rate all differ per machine, so showing one machine's odds beside another's price would
 * be quietly wrong.
 */

const TIERS = [
  { key: "common", label: "Common", color: "var(--common)" },
  { key: "uncommon", label: "Uncommon", color: "var(--uncommon)" },
  { key: "rare", label: "Rare", color: "var(--rare)" },
  { key: "epic", label: "Epic", color: "var(--epic)" },
];

const usd0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** "$30 to $60", and an open-ended top band reads "and up" rather than a fake ceiling. */
function bandLabel(range: { start: number; end: number } | undefined, isTop: boolean): string {
  if (!range) return "";
  return isTop ? `${usd0(range.start)} and up` : `${usd0(range.start)} to ${usd0(range.end)}`;
}


export function HowItWorks({
  machines,
  machine,
  depositsEnabled = false,
}: {
  machines: Machine[];
  machine: Machine | null;
  /** Deposits are explained only once the chain says they work. See getDepositsEnabled. */
  depositsEnabled?: boolean;
}) {
  const list = machines.length ? machines : machine ? [machine] : [];
  const [pickedId, setPickedId] = useState<string | null>(null);

  /**
   * Has anything been minted? It decides which explorer page the collection links to.
   *
   * The token page shows "Pokemon World Assets (PWA)" but does not exist until the first
   * Transfer, because Blockscout only creates a token record when it sees one. The address
   * page always resolves but titles itself "MirrorNFT", the Solidity contract name. So one is
   * a dead link and the other is developer-facing, and which is wrong depends entirely on
   * whether a card exists yet.
   *
   * Defaults to false, so an unreadable chain gives the link that always resolves rather than
   * a 404.
   */
  const wagmi = useConfig();
  const [hasMints, setHasMints] = useState(false);
  useEffect(() => {
    if (!CONTRACTS.mirror) return;
    let live = true;
    void readContract(wagmi, {
      address: CONTRACTS.mirror,
      abi: MIRROR_NFT_ABI,
      functionName: "nextTokenId",
      chainId: robinhoodChain.id,
    })
      .then((n) => { if (live) setHasMints(BigInt(n as bigint) > 1n); })
      .catch(() => {});
    return () => { live = false; };
  }, [wagmi]);

  // Defaults to whatever machine the visitor was last looking at on the floor, so arriving
  // here does not silently switch the pack under them.
  const picked = list.find((m) => m.id === pickedId) ?? machine ?? list[0] ?? null;

  // Matches MARKET_FEE_BPS at deploy (250 = 2.5%). Stated here so the page cannot quietly
  // drift from what the contract actually charges.
  const marketFeePct = 2.5;

  const steps = [
    {
      icon: "pay" as const,
      title: "Pay in USDG",
      body: "Pick a machine and pay in USDG on Robinhood Chain. Your payment is held in escrow by the contract until a pack has actually been opened for you.",
    },
    {
      icon: "open" as const,
      title: "We open a real pack",
      body: "Your USDG buys a genuine Collector Crypt pack verifiable onchain.",
    },
    {
      icon: "mint" as const,
      title: "You receive the card",
      body: "An NFT is minted to you on Robinhood Chain, backed one to one by the graded card held in the Collector Crypt vault.",
    },
    {
      icon: "exit" as const,
      title: "Keep it, sell it, or take it",
      body: "Hold it for as long as you like, sell it back to the vault, list it on the marketplace or withdraw and claim the physical card.",
    },
  ];

  return (
    <div className="hiw">
      <header className="hiw-hero">
        <span className="eyebrow">How it works</span>
        <h1 className="hiw-title">{BRAND_FULL}</h1>
        <p className="hiw-lead">
          {BRAND_NAME} opens real Collector Crypt packs and mints you a token backed one to
          one by the card inside. You pay in USDG on Robinhood Chain. The card stays graded,
          insured and vaulted until you decide what to do with it.
        </p>
      </header>

      {/*
        A reference page laid out as reference: contents on the left, content on the right.

        This was thirteen sections stacked down the middle of the page with no way to see
        what was in it or jump to a part. That shape is a landing page, and this is not one
        — it is the page someone opens with a specific question. The list makes the scope
        visible and the answer reachable.
      */}
      <div className="hiw-body">
        <div className="hiw-content">

          <section className="hiw-section" id="the-flow">
            <h2 className="hiw-h2">The flow</h2>
            <ol className="hiw-numbered">
              {steps.map((s) => (
                <li key={s.title}>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </li>
              ))}
            </ol>
          </section>

          <section className="hiw-section" id="getting-usdg-into-your-wallet">
            <h2 className="hiw-h2">Getting USDG into your wallet</h2>
            <p>
              USDG is Robinhood Chain's stablecoin. One USDG is one dollar, and it is what
              packs are priced in.
            </p>
            <p>
              Some wallets do not recognise USDG by default, so a funded balance can show as
              nothing until you import the token. You also need a small amount of ETH for
              gas.
            </p>
            <dl className="hiw-facts">
              <div>
                <dt>USDG contract</dt>
                <dd><Address value="0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" /></dd>
              </div>
            </dl>
          </section>

          <section className="hiw-section" id="what-stands-behind-your-token">
            <h2 className="hiw-h2">What stands behind your token</h2>
            <p>
              In the vault sits a professionally graded card, insured at a stated value and
              held in custody. It does not move while your token exists.
            </p>
            <p>
              In your wallet sits an ERC-721 on Robinhood Chain carrying the grade,
              certificate number and insured value of that exact card. There is never more
              than one token per card.
            </p>
          </section>

          <section className="hiw-section" id="where-the-cards-actually-are">
            <h2 className="hiw-h2">Where the cards actually are</h2>
            <p>
              The cards you receive are Robinhood Chain NFTs backed one to one by Collector
              Crypt cards. The Collector Crypt NFT representing each one stays in Solana
              custody for exactly as long as your Robinhood Chain NFT exists.
            </p>
          </section>

          <section className="hiw-section" id="the-collection">
            <h2 className="hiw-h2">The collection</h2>
            <p>
              Every card opened here is minted into one collection on Robinhood Chain. One
              token per card, minted only once the physical card is already in custody, and
              burned when it leaves.
            </p>
            <dl className="hiw-facts">
              <div><dt>Name</dt><dd>GRAILS</dd></div>
              <div><dt>Symbol</dt><dd>GRAILS</dd></div>
              <div><dt>Standard</dt><dd>ERC-721</dd></div>
              <div><dt>Network</dt><dd>Robinhood Chain</dd></div>
              {CONTRACTS.mirror && (
                <div>
                  <dt>Contract</dt>
                  <dd><Address value={CONTRACTS.mirror} /></dd>
                </div>
              )}
            </dl>
            {CONTRACTS.mirror && (
              <a
                className="hiw-link"
                href={collectionUrl(CONTRACTS.mirror, hasMints)}
                target="_blank"
                rel="noreferrer"
              >
                View the collection on the explorer
              </a>
            )}
          </section>

          {/* Guarded as a unit: without the contract address this section has nothing to
              give. It would print an empty address and link nowhere. */}
          {CONTRACTS.mirror && (
            <section className="hiw-section" id="seeing-your-card-in-your-wallet">
              <h2 className="hiw-h2">Seeing your card in your wallet</h2>
              <p>
                Most wallets only detect NFTs automatically on the larger networks, so your
                card may not appear on its own. Add it once and it stays.
              </p>
              <ol className="hiw-numbered hiw-numbered-tight">
                <li><p>Make sure your wallet is on Robinhood Chain.</p></li>
                <li><p>Open the NFT section in your wallet and select Import NFT or Add NFT.</p></li>
                <li><p>Paste the contract address below, and the token ID shown on your card.</p></li>
              </ol>
              <dl className="hiw-facts">
                <div>
                  <dt>Contract</dt>
                  <dd><Address value={CONTRACTS.mirror} /></dd>
                </div>
              </dl>
            </section>
          )}

          <section className="hiw-section" id="the-marketplace">
            <h2 className="hiw-h2">The marketplace</h2>
            <p>
              Cards can be traded between users. Selling to other users often beats
              selling back to the vault.
            </p>
            <dl className="hiw-defs">
              <div>
                <dt>List</dt>
                <dd>
                  Set your price and the card stays in your wallet. It moves only when someone
                  buys it, change the price or delist at any time.
                </dd>
              </div>
              <div>
                <dt>Offer</dt>
                <dd>
                  Bid on any listed card. Withdraw the offer whenever you like.
                </dd>
              </div>
              <div>
                <dt>Buy</dt>
                <dd>
                  Pay the asking price and the card is yours in the same transaction.
                </dd>
              </div>
            </dl>
            <p className="hiw-note">
              Neither your card nor your USDG is ever held by the marketplace. Listing grants
              permission to move a card and an offer grants permission to spend, so both sides
              keep what is theirs until a trade actually happens. A {marketFeePct}% fee applies
              to a completed sale.
            </p>
          </section>

          {/* Explained only when deposits actually work. Describing a feature whose button is
              hidden sends people looking for something that is not there. */}
          {depositsEnabled && (
            <section className="hiw-section" id="deposit">
              <h2 className="hiw-h2">Deposit</h2>
              <p>
                Cards you already own on Collector Crypt can be brought across to Robinhood
                Chain
              </p>
              <dl className="hiw-defs">
                <div>
                  <dt>Transfer the card</dt>
                  <dd>
                    Connect the wallet holding your cards, pick one and send it to the
                    vault. Only cards from Collector Crypt's vault can be deposited.
                  </dd>
                </div>
                <div>
                  <dt>Receive the NFT</dt>
                  <dd>
                    Once the card arrives we mint the NFT on Robinhood and send it to your
                    wallet.
                    The physical card stays in the vault exactly as it was.
                  </dd>
                </div>
                <div>
                  <dt>Trade it or withdraw it back</dt>
                  <dd>
                    A deposited card behaves like any other in your collection. List it, take
                    offers, or withdraw it to get the Solana NFT back.
                  </dd>
                </div>
              </dl>
            </section>
          )}

          {picked && list.length > 0 && (
            <section className="hiw-section" id="odds-and-pricing">
              <h2 className="hiw-h2">Odds and pricing</h2>

              <div className="hiw-picker" role="tablist" aria-label="Choose a pack">
                {list.map((m) => (
                  <button
                    key={m.id}
                    role="tab"
                    aria-selected={m.id === picked.id}
                    data-active={m.id === picked.id}
                    className="hiw-pick"
                    onClick={() => setPickedId(m.id)}
                  >
                    {/* Our label, not Collector Crypt's product name: "Pokémon 250" says
                        which machine and what it costs, where "Legendary Pokémon Gacha
                        Pack" says neither. */}
                    {machineLabel(m.id)}
                  </button>
                ))}
              </div>

              <table className="hiw-odds-table">
                <thead>
                  <tr>
                    <th>Tier</th>
                    <th>Value</th>
                    <th>Chance</th>
                  </tr>
                </thead>
                <tbody>
                  {[...TIERS].reverse().map((t, i) => {
                    const pct = (picked.odds[t.key] ?? 0) * 100;
                    return (
                      <tr key={t.key}>
                        <td>
                          <span className="hiw-odd-dot" style={{ background: t.color }} />
                          {t.label}
                        </td>
                        <td>{bandLabel(picked.tierRanges?.[t.key], i === 0)}</td>
                        <td>{pct % 1 === 0 ? pct : pct.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <p className="hiw-note">
                These pack odds and value ranges are provided directly by Collector
                Crypt.
              </p>

            </section>
          )}

          <section className="hiw-section" id="questions">
            <h2 className="hiw-h2">Questions</h2>
            <div className="hiw-faq">
              {[
                {
                  q: "What is USDG and where do I get it?",
                  a: "USDG is a dollar backed stablecoin issued by Paxos, and it is the currency of Robinhood Chain. One USDG is one dollar. You will need a small amount of ETH for gas as well.",
                },
                {
                  q: "Do I need a Solana wallet?",
                  a: "Not to open packs, sell cards back or trade them here. You only need one if you want to withdraw the underlying Solana asset out of custody.",
                },
                {
                  q: "What exactly is insured value?",
                  a: "It is the vault's own reference valuation for a graded card, and it is what every sell back quote is calculated from. It is not a market price, and a card may be worth more or less in a live auction.",
                },
                {
                  q: "What if something goes wrong while my pack is opening?",
                  a: "A pack that never opens is refunded in full. Your payment sits in escrow until the moment we buy your pack, and if anything fails before that the contract refunds you automatically.",
                },
                {
                  q: "Can I actually get the physical card shipped?",
                  a: "Yes. Withdraw the Solana asset, then redeem it with Collector Crypt directly. Redemption is theirs, so it needs your own verified account with them and is subject to their fees and shipping.",
                },
              ].map((f) => (
                <details className="hiw-faq-item" key={f.q}>
                  <summary>
                    <span>{f.q}</span>
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M6 9.5l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
