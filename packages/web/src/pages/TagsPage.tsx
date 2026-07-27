import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Tag } from "../api.ts";
import { fmtDate } from "../format.ts";

type SortKey = "snips" | "label" | "lastDate" | "shows" | "favorites";

export default function TagsPage() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [sort, setSort] = useState<SortKey>("snips");
  const [showRetired, setShowRetired] = useState(false);

  const load = useCallback(() => {
    api<Tag[]>(`/api/tags?retired=${showRetired ? "1" : "0"}`).then(setTags);
  }, [showRetired]);
  useEffect(load, [load]);
  useEffect(() => {
    window.addEventListener("resurface:synced", load);
    return () => window.removeEventListener("resurface:synced", load);
  }, [load]);

  const sorted = [...tags].sort((a, b) => {
    if (sort === "label") return a.label.localeCompare(b.label);
    if (sort === "lastDate") return (b.lastDate ?? "").localeCompare(a.lastDate ?? "");
    return (b[sort] as number) - (a[sort] as number);
  });
  const max = Math.max(1, ...tags.map((t) => t.snips));
  const retired = tags.filter((t) => t.live === 0).length;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Tags</h1>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="card px-2 py-1 text-sm"
        >
          <option value="snips">Most snips</option>
          <option value="label">A–Z</option>
          <option value="lastDate">Most recent</option>
          <option value="shows">Most shows</option>
          <option value="favorites">Most ⭐ favorites</option>
        </select>
        <label className="flex cursor-pointer items-center gap-1 text-sm ink-2">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          include retired
        </label>
      </div>
      <p className="muted mb-4 text-xs">
        Tags you applied inside the Snipd app — read-only here; add or remove them in Snipd and hit Sync now.
        {retired > 0 && showRetired && ` ${retired} retired (no snips left in the vault, kept forever).`}
      </p>

      {tags.length === 0 && (
        <div className="card p-8 text-center">
          <p className="mb-1 text-sm font-medium">No tags yet</p>
          <p className="muted text-sm">
            Tag a snip in the Snipd app, let the Obsidian plugin sync, then hit Sync now.
          </p>
        </div>
      )}

      <div className="space-y-1">
        {sorted.map((t) => (
          <Link
            key={t.id}
            to={`/tags/${encodeURIComponent(t.key)}`}
            className="card flex items-center gap-3 p-3 hover:opacity-90"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-sm font-medium">#{t.label}</span>
                {t.live === 0 && (
                  <span className="muted rounded border px-1 text-[10px] uppercase tracking-wide hairline">
                    retired
                  </span>
                )}
              </div>
              <div className="mt-1 h-1.5 rounded-sm" style={{ background: "var(--grid)" }}>
                <div
                  className="h-1.5 rounded-sm"
                  style={{ width: `${Math.max(2, (t.snips / max) * 100)}%`, background: "var(--series-1)" }}
                />
              </div>
            </div>
            <div className="shrink-0 text-right text-xs" style={{ fontVariantNumeric: "tabular-nums" }}>
              <div className="text-sm font-medium">{t.snips.toLocaleString()} snips</div>
              <div className="muted">
                {t.shows} {t.shows === 1 ? "show" : "shows"}
                {t.favorites > 0 && ` · ${t.favorites} ⭐`}
                {t.lastDate && ` · ${fmtDate(t.lastDate)}`}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
