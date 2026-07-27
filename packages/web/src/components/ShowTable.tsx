import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { ShowStatsRow } from "../api.ts";
import { fmtDate, fmtDuration, fmtHours } from "../format.ts";

type SortKey =
  | "estimatedSec"
  | "snipSec"
  | "episodes"
  | "snips"
  | "snipsPerHour"
  | "snipsPerEpisode"
  | "avgEpisodeSec"
  | "lastActivity";

const COLUMNS: { key: SortKey; label: string; title: string }[] = [
  { key: "episodes", label: "Episodes", title: "Episodes with at least one snip — the lens where short daily shows shine" },
  { key: "snips", label: "Snips", title: "Snips in period" },
  { key: "estimatedSec", label: "Listening", title: "Full length of every episode you snipped (overcounts unfinished ones)" },
  { key: "snipSec", label: "Snip time", title: "Audio your snips captured; overlaps counted once" },
  { key: "avgEpisodeSec", label: "Avg ep", title: "Mean episode length — what makes a show short- or long-form" },
  { key: "snipsPerHour", label: "Snips/hr", title: "Density per listening hour — structurally favors SHORT episodes" },
  { key: "snipsPerEpisode", label: "Snips/ep", title: "Density per episode — the opposite bias, favors LONG episodes" },
  { key: "lastActivity", label: "Last active", title: "Most recent snip date" },
];

/** Legacy sort keys persisted by older builds. */
const SORT_ALIASES: Record<string, SortKey> = { confirmedSec: "snipSec" };
const STORE_KEY = "resurface.showTable.sort";

export default function ShowTable({ rows }: { rows: ShowStatsRow[] }) {
  const [sort, setSort] = useState<SortKey>(() => {
    const saved = localStorage.getItem(STORE_KEY) ?? "";
    const key = SORT_ALIASES[saved] ?? (saved as SortKey);
    return COLUMNS.some((c) => c.key === key) ? key : "estimatedSec";
  });
  const [asc, setAsc] = useState(false);
  const [limit, setLimit] = useState(15);

  const sorted = useMemo(() => {
    const s = [...rows].sort((a, b) => {
      const av = a[sort] ?? -1;
      const bv = b[sort] ?? -1;
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    if (!asc) s.reverse();
    return s;
  }, [rows, sort, asc]);

  function clickSort(key: SortKey) {
    if (key === sort) setAsc(!asc);
    else {
      setSort(key);
      setAsc(false);
      localStorage.setItem(STORE_KEY, key);
    }
  }

  return (
    <div className="card overflow-x-auto p-4">
      <h2 className="mb-1 text-sm font-semibold">
        Shows <span className="muted font-normal">· click a column to re-rank</span>
      </h2>
      <p className="muted mb-3 text-xs">
        Hours favor long shows and snips/hr favors short ones — rank by episodes or snips/ep to see the other side.
      </p>
      <table className="w-full text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>
        <thead>
          <tr className="border-b hairline text-left">
            <th className="py-2 pr-3 font-medium muted">Show</th>
            {COLUMNS.map((c) => (
              <th key={c.key} className="cursor-pointer py-2 pr-3 text-right font-medium muted" title={c.title} onClick={() => clickSort(c.key)}>
                {c.label}
                {sort === c.key ? (asc ? " ↑" : " ↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, limit).map((r) => (
            <tr key={r.id} className="border-b hairline">
              <td className="max-w-64 py-2 pr-3">
                <Link to={`/shows/${r.id}`} className="link flex items-center gap-2">
                  {r.imageUrl && (
                    <img src={r.imageUrl} alt="" loading="lazy" className="h-6 w-6 shrink-0 rounded" />
                  )}
                  <span className="truncate">{r.title}</span>
                </Link>
              </td>
              <td className="py-2 pr-3 text-right">{r.episodes}</td>
              <td className="py-2 pr-3 text-right">{r.snips}</td>
              <td className="py-2 pr-3 text-right">{fmtHours(r.estimatedSec)}</td>
              <td className="py-2 pr-3 text-right">{fmtHours(r.snipSec)}</td>
              <td className="py-2 pr-3 text-right ink-2">
                {r.avgEpisodeSec ? fmtDuration(r.avgEpisodeSec) : "–"}
              </td>
              <td className="py-2 pr-3 text-right">{r.snipsPerHour ?? "–"}</td>
              <td className="py-2 pr-3 text-right">{r.snipsPerEpisode ?? "–"}</td>
              <td className="py-2 pr-3 text-right ink-2">{fmtDate(r.lastActivity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && (
        <button className="mt-3 text-sm link" onClick={() => setLimit(limit + 25)}>
          Show more ({rows.length - limit} remaining)
        </button>
      )}
    </div>
  );
}
