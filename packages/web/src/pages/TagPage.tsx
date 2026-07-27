import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Tag, type TagSnip } from "../api.ts";
import SnipCard from "../components/SnipCard.tsx";
import { fmtDate } from "../format.ts";

export default function TagPage() {
  const { key = "" } = useParams();
  const [tag, setTag] = useState<Tag | null>(null);
  const [snips, setSnips] = useState<TagSnip[]>([]);
  const [total, setTotal] = useState(0);
  const [order, setOrder] = useState<"desc" | "asc">("desc");
  const [limit, setLimit] = useState(25);

  const load = useCallback(() => {
    api<Tag[]>("/api/tags?retired=1").then((all) => setTag(all.find((t) => t.key === key) ?? null));
    api<{ snips: TagSnip[]; total: number }>(
      `/api/tags/${encodeURIComponent(key)}/snips?order=${order}&limit=${limit}`
    ).then((r) => {
      setSnips(r.snips);
      setTotal(r.total);
    });
  }, [key, order, limit]);
  useEffect(load, [load]);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <Link to="/tags" className="link text-sm">
          ← Tags
        </Link>
        <h1 className="text-lg font-semibold">#{tag?.label ?? key}</h1>
        <div className="ml-auto flex items-center gap-2">
          <button className="card px-2 py-1 text-sm" onClick={() => setOrder(order === "desc" ? "asc" : "desc")}>
            {order === "desc" ? "Newest first ↓" : "Oldest first ↑"}
          </button>
          <Link className="card link px-2 py-1 text-sm" to={`/search?tags=${encodeURIComponent(key)}`}>
            Search within
          </Link>
          <a className="card link px-2 py-1 text-sm" href={`/api/export/tag/${encodeURIComponent(key)}`}>
            Export .md
          </a>
        </div>
      </div>
      <p className="muted mb-4 text-xs">
        {total.toLocaleString()} snips tagged in Snipd
        {tag?.shows ? ` across ${tag.shows} shows` : ""}
        {tag?.firstDate && tag.lastDate ? ` · ${fmtDate(tag.firstDate)} – ${fmtDate(tag.lastDate)}` : ""}
        {tag?.favorites ? ` · ${tag.favorites} also ⭐ favorited` : ""}
      </p>

      <div className="space-y-3">
        {snips.map((s) => (
          <SnipCard key={s.id} snip={s} />
        ))}
      </div>

      {snips.length < total && (
        <button className="mt-4 text-sm link" onClick={() => setLimit(limit + 25)}>
          Show more ({total - snips.length} remaining)
        </button>
      )}
      {total === 0 && <p className="muted mt-8 text-center text-sm">Nothing carries this tag right now.</p>}
    </div>
  );
}
