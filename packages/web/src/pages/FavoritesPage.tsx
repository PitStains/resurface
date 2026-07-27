import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type BookmarkType, type TimelineEntry } from "../api.ts";
import TagChip from "../components/TagChip.tsx";
import SnipDetails from "../components/SnipDetails.tsx";
import { Bookmark, MissingBadge, useBookmarks } from "../favorites.tsx";
import { fmtClock, fmtDate } from "../format.ts";

/** Bullets and markdown furniture stripped, for a plain multi-line preview. */
function previewText(md: string): string {
  return md
    .replace(/^[\s>]*[-*+]\s+/gm, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const TYPE_LABEL: Record<BookmarkType, string> = { show: "Show", episode: "Episode", snip: "Snip" };

/**
 * A starred item, led by its podcast: show › episode is the primary line so the
 * list always says which show a favorite came from; the snip's own title,
 * timestamp and tags sit underneath.
 */
function EntryRow({ e }: { e: TimelineEntry }) {
  return (
    <div className="card flex items-start gap-3 p-3">
      {e.kind === "favorite" ? (
        <span title="Favorited in Snipd (read-only — change it in the app)">⭐</span>
      ) : (
        <Bookmark type={e.type} id={e.id} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
          {e.showId ? (
            <Link to={`/shows/${e.showId}`} className="font-semibold hover:underline">
              {e.showTitle ?? e.title}
            </Link>
          ) : (
            <span className="font-semibold">{e.showTitle ?? e.title}</span>
          )}
          {e.episodeTitle && e.type !== "episode" && <span className="muted">›</span>}
          {e.episodeTitle && e.episodeId && e.type !== "episode" && (
            <Link to={`/episodes/${e.episodeId}`} className="min-w-0 truncate font-medium hover:underline">
              {e.episodeTitle}
            </Link>
          )}
          {e.type === "episode" && e.episodeId && (
            <>
              <span className="muted">›</span>
              <Link to={`/episodes/${e.episodeId}`} className="min-w-0 truncate font-medium hover:underline">
                {e.title}
              </Link>
            </>
          )}
          {/* Snipd favorites are always snips, so the type badge is noise there. */}
          {e.kind === "bookmark" && (
            <span className="muted rounded border px-1 text-[10px] uppercase tracking-wide hairline">
              {TYPE_LABEL[e.type]}
            </span>
          )}
          {e.shareUrl && (
            <a href={e.shareUrl} target="_blank" rel="noreferrer" className="link ml-auto text-xs">
              Open ↗
            </a>
          )}
        </div>
        {e.type === "snip" && (
          <div className="mt-0.5 flex flex-wrap items-baseline gap-2">
            <span className="ink-2 text-sm">{e.title}</span>
            {e.startSec !== null && (
              <span className="muted text-xs" style={{ fontVariantNumeric: "tabular-nums" }}>
                @ {fmtClock(e.startSec)}
              </span>
            )}
            {e.tags.map((t) => (
              <TagChip key={t} label={t} />
            ))}
            {e.missingFromVault && <MissingBadge />}
          </div>
        )}
        {e.quoteText && (
          <blockquote className="mt-1 border-l-2 pl-2 text-sm italic ink-2" style={{ borderColor: "var(--series-1)" }}>
            “{e.quoteText}”
          </blockquote>
        )}
        {/* A few lines of the note as a preview, collapsed to five lines; the
            full note and transcript are one click away, in place. */}
        {e.type === "snip" && e.summaryMd && (
          <p className="ink-2 mt-1 whitespace-pre-line text-sm" style={{
            display: "-webkit-box",
            WebkitLineClamp: 5,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}>
            {previewText(e.summaryMd)}
          </p>
        )}
        {e.type === "snip" && (
          <SnipDetails snipId={e.id} has={{ quote: !!e.quoteText }} />
        )}
      </div>
    </div>
  );
}

export default function FavoritesPage() {
  const [tab, setTab] = useState<"favorites" | "bookmarks">("favorites");
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [type, setType] = useState<"" | BookmarkType>("");
  const [order, setOrder] = useState<"desc" | "asc">("desc");
  const { counts } = useBookmarks();

  const load = useCallback(() => {
    if (tab === "favorites") {
      api<TimelineEntry[]>(`/api/favorites/timeline?order=${order}`).then(setEntries);
    } else {
      const p = new URLSearchParams({ order });
      if (type) p.set("type", type);
      api<TimelineEntry[]>(`/api/bookmarks/timeline?${p}`).then(setEntries);
    }
  }, [tab, type, order]);
  useEffect(load, [load]);
  useEffect(() => {
    window.addEventListener("resurface:synced", load);
    return () => window.removeEventListener("resurface:synced", load);
  }, [load]);

  let lastDate = "";
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Starred</h1>
        <div className="flex gap-1">
          <button
            onClick={() => setTab("favorites")}
            className={`rounded-md px-3 py-1.5 text-sm ${tab === "favorites" ? "font-semibold" : "ink-2"}`}
            style={tab === "favorites" ? { background: "var(--series-1-soft)" } : {}}
          >
            ⭐ Snipd favorites
          </button>
          <button
            onClick={() => setTab("bookmarks")}
            className={`rounded-md px-3 py-1.5 text-sm ${tab === "bookmarks" ? "font-semibold" : "ink-2"}`}
            style={tab === "bookmarks" ? { background: "var(--series-1-soft)" } : {}}
          >
            🔖 Bookmarks ({counts.snip + counts.episode + counts.show})
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {tab === "bookmarks" && (
            <select value={type} onChange={(e) => setType(e.target.value as "" | BookmarkType)} className="card px-2 py-1 text-sm">
              <option value="">All types</option>
              <option value="snip">Snips</option>
              <option value="episode">Episodes</option>
              <option value="show">Shows</option>
            </select>
          )}
          <button className="card px-2 py-1 text-sm" onClick={() => setOrder(order === "desc" ? "asc" : "desc")}>
            {order === "desc" ? "Newest first ↓" : "Oldest first ↑"}
          </button>
          <a className="card px-2 py-1 text-sm link" href="/api/export/favorites">
            Export .md
          </a>
        </div>
      </div>
      <p className="muted mb-4 text-xs">
        {tab === "favorites"
          ? `Snips you favorited inside the Snipd app (${entries.length}) — read-only here; star or unstar in Snipd and sync.`
          : "Stars you add inside Resurface, on snips, episodes, or whole shows."}
      </p>

      {entries.length === 0 && (
        <div className="card p-8 text-center">
          <p className="mb-1 text-sm font-medium">Nothing here yet</p>
          <p className="muted text-sm">
            {tab === "favorites"
              ? "Favorite snips in the Snipd app (⭐), let the Obsidian plugin sync, then hit Sync now."
              : "Use 🔖 on any snip, episode, or show page to bookmark it."}
          </p>
        </div>
      )}

      <div className="space-y-2">
        {entries.map((e) => {
          const showDate = e.date !== lastDate;
          lastDate = e.date ?? "";
          return (
            <div key={`${e.kind}:${e.type}:${e.id}`}>
              {showDate && <div className="muted mb-1 mt-4 text-xs font-medium">{fmtDate(e.date)}</div>}
              <EntryRow e={e} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
