import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { getLeaderboard, type LeaderRow, type LeaderSort } from "./client.ts";
import { Address } from "./Address.tsx";
import { resolveNames } from "../lib/names";

/**
 * Two leaderboards over the same data, switched rather than shown side by side: the ranking
 * only means something if there is one obvious first place, and two tables competing for
 * that claim reads as neither being real.
 *
 * "Value" is the sum of insured value across everything a wallet has pulled. The column is
 * labelled just "Value" per the brief, but it is the same figure the rest of the site calls
 * insured value, so the two can never disagree.
 */

const TABS: { key: LeaderSort; label: string; note: string }[] = [
  { key: "value", label: "Value", note: "Ranked by the total value of every card pulled." },
  { key: "packs", label: "Packs opened", note: "Ranked by how many packs a wallet has opened." },
];

const usd = (base: string) =>
  `$${(Number(base) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

/** Gold, silver, bronze, then nothing. A rank badge past third is just noise. */
const medal = (i: number) => (i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "");

export function Leaderboard() {
  const { address } = useAccount();
  const [sort, setSort] = useState<LeaderSort>("value");
  const [rows, setRows] = useState<LeaderRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getLeaderboard(sort)
      .then(async (r) => {
        if (cancelled) return;
        setRows(r.rows);
        // Resolved after the rows are shown, not before: a slow or failing name lookup must
        // never hold up the ranking itself, which is the thing people came for.
        const resolved = await resolveNames(r.rows.map((row) => row.address));
        if (!cancelled) setNames(resolved);
      })
      .catch(() => !cancelled && setRows([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sort]);

  return (
    <div className="lb">
      <header className="lb-head">
        <h1>Leaderboards</h1>
      </header>

      <div className="lb-tabs" role="tablist" aria-label="Leaderboard type">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={t.key === sort}
            data-active={t.key === sort}
            className="lb-tab"
            onClick={() => setSort(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="lb-empty">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="lb-empty-panel">
          <h2>No packs opened yet</h2>
          <p>The leaderboard fills up as soon as people start opening. Be the first.</p>
        </div>
      ) : (
        /*
         * One clean board, top to bottom. The podium-plus-table split read as two separate
         * widgets; a single ranked list with the top three marked by medal-coloured ranks is
         * what people expect a leaderboard to look like, and it scans in one pass. The sorted
         * column is emphasised so it is obvious what the ranking is by.
         */
        <ol className="lb-board">
          <li className="lb-board-head" aria-hidden="true">
            <span>#</span>
            {/* "Player", not "Wallet": the column shows a username wherever one exists,
                matching the battles leaderboard's heading for the same information. */}
            <span>Player</span>
            <span className="lb-col-num" data-primary={sort === "packs" || undefined}>Packs</span>
            <span className="lb-col-num" data-primary={sort === "value" || undefined}>Value</span>
          </li>
          {rows.map((r, i) => {
            const you = address && r.address.toLowerCase() === address.toLowerCase();
            return (
              <li className="lb-entry" key={r.address} data-medal={medal(i)} data-you={you || undefined}>
                <span className="lb-entry-rank">{i + 1}</span>
                <span className="lb-entry-who">
                  {/* Same shape as the battles leaderboard: the username leads and the
                      wallet sits under it, quieter. A wallet with no username claimed still
                      shows as the address alone, exactly as that board does. */}
                  {names[r.address.toLowerCase()] ? (
                    <span className="lb-entry-id">
                      <span className="lb-entry-name">{names[r.address.toLowerCase()]}</span>
                      <Address value={r.address} short className="lb-entry-addr" />
                    </span>
                  ) : (
                    <Address value={r.address} short />
                  )}
                  {you && <span className="lb-you">You</span>}
                </span>
                <span className="lb-col-num lb-entry-packs" data-primary={sort === "packs" || undefined}>
                  {r.packsOpened.toLocaleString("en-US")}
                </span>
                <span className="lb-col-num lb-entry-value" data-primary={sort === "value" || undefined}>
                  {usd(r.totalValueUsd)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
