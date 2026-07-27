import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, postJson, type BookmarkType } from "./api.ts";

/**
 * Terminology: ⭐ "Favorites" come from the Snipd app via the export (read-only
 * here — change them in Snipd and resync). 🔖 "Bookmarks" are Resurface's own
 * stars on shows/episodes/snips.
 */
interface BookmarkState {
  has: (type: BookmarkType, id: string) => boolean;
  toggle: (type: BookmarkType, id: string) => void;
  counts: Record<BookmarkType, number>;
}

const Ctx = createContext<BookmarkState>({
  has: () => false,
  toggle: () => {},
  counts: { show: 0, episode: 0, snip: 0 },
});

export function BookmarksProvider({ children }: { children: ReactNode }) {
  const [sets, setSets] = useState<Record<BookmarkType, Set<string>>>({
    show: new Set(),
    episode: new Set(),
    snip: new Set(),
  });

  useEffect(() => {
    api<Record<BookmarkType, string[]>>("/api/bookmarks").then((r) =>
      setSets({ show: new Set(r.show), episode: new Set(r.episode), snip: new Set(r.snip) })
    );
  }, []);

  const has = (type: BookmarkType, id: string) => sets[type].has(id);
  const toggle = (type: BookmarkType, id: string) => {
    const on = !sets[type].has(id);
    setSets((prev) => {
      const next = { ...prev, [type]: new Set(prev[type]) };
      if (on) next[type].add(id);
      else next[type].delete(id);
      return next;
    });
    postJson("/api/bookmarks", { type, id, on }).catch(() => {});
  };

  return (
    <Ctx.Provider
      value={{ has, toggle, counts: { show: sets.show.size, episode: sets.episode.size, snip: sets.snip.size } }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useBookmarks = () => useContext(Ctx);

/** In-app bookmark toggle (🔖). */
export function Bookmark({ type, id, size = "text-base" }: { type: BookmarkType; id: string; size?: string }) {
  const { has, toggle } = useBookmarks();
  const on = has(type, id);
  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(type, id);
      }}
      title={on ? `Remove ${type} bookmark` : `Bookmark this ${type}`}
      aria-pressed={on}
      className={`${size} leading-none transition-opacity ${on ? "" : "opacity-30 grayscale hover:opacity-70"}`}
    >
      🔖
    </button>
  );
}

/** Snipd ⭐ favorite badge (read-only — set in the Snipd app). */
export function FavBadge({ small }: { small?: boolean }) {
  return (
    <span title="Favorited in Snipd (read-only — change it in the app)" className={small ? "text-xs" : "text-sm"}>
      ⭐
    </span>
  );
}

/** Badge for content that no longer exists in the Snipd export (kept forever here). */
export function MissingBadge() {
  return (
    <span
      className="muted rounded border px-1 text-[10px] uppercase tracking-wide hairline"
      title="No longer present in the Snipd export — kept in Resurface under the never-delete policy"
    >
      not in vault
    </span>
  );
}
