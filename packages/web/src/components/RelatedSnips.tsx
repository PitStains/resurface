import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type RelatedSnip } from "../api.ts";
import { fmtClock, fmtDate } from "../format.ts";

/**
 * "Similar snips" — neighbors in meaning, from anywhere in the library. Loads
 * on demand so lists stay fast, and stays quiet when the index isn't built.
 */
export default function RelatedSnips({ snipId }: { snipId: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<RelatedSnip[] | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && items === null) {
      setItems(await api<RelatedSnip[]>(`/api/snips/${snipId}/related?k=6`).catch(() => []));
    }
  }

  return (
    <div className="mt-2">
      <button className="link text-xs" onClick={toggle}>
        {open ? "Hide similar snips" : "Similar snips"}
      </button>
      {open && items === null && <p className="muted mt-1 text-xs">Finding neighbors…</p>}
      {open && items?.length === 0 && (
        <p className="muted mt-1 text-xs">
          Nothing yet — build the meaning index on the dashboard to enable this.
        </p>
      )}
      {open && items && items.length > 0 && (
        <ul className="mt-2 space-y-1.5 border-l-2 pl-3 text-sm hairline">
          {items.map((r) => (
            <li key={r.id}>
              <div className="flex items-baseline gap-2">
                <Link to={`/episodes/${r.episodeId}`} className="min-w-0 truncate font-medium hover:underline">
                  {r.showTitle} <span className="muted">›</span> {r.episodeTitle}
                </Link>
                <span
                  className="muted shrink-0 text-xs"
                  title="Cosine similarity: 1.0 is identical meaning"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {r.score.toFixed(2)}
                </span>
              </div>
              <div className="ink-2 text-xs">
                {r.title ?? "(untitled snip)"} · {fmtClock(r.startSec)} · {fmtDate(r.lastSnipDate)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
