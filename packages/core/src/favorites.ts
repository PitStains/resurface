import type { DatabaseSync } from "node:sqlite";
import { parseTags } from "./tags.ts";

/**
 * Terminology (owner's definition):
 * - "Favorites" = snips starred ⭐ in the Snipd app itself; they arrive via the
 *   export (snips.favorited) and are read-only here.
 * - "Bookmarks" = stars added inside Resurface (show/episode/snip), stored in
 *   the local `bookmarks` table.
 */
export type BookmarkType = "show" | "episode" | "snip";

/**
 * How much of a note travels with a timeline row. The UI clamps the preview to
 * about five lines, and expanding a row fetches the whole snip anyway — sending
 * every full note made the Starred page a 3 MB download for 570 rows.
 */
const PREVIEW_CHARS = 600;

export function setBookmark(db: DatabaseSync, type: BookmarkType, id: string, on: boolean): void {
  if (on)
    db.prepare("INSERT OR IGNORE INTO bookmarks (entity_type, entity_id) VALUES (?, ?)").run(type, id);
  else db.prepare("DELETE FROM bookmarks WHERE entity_type = ? AND entity_id = ?").run(type, id);
}

/** All bookmark ids by type — the client uses this for star states everywhere. */
export function listBookmarks(db: DatabaseSync): Record<BookmarkType, string[]> {
  const rows = db.prepare("SELECT entity_type t, entity_id id FROM bookmarks").all() as unknown as {
    t: BookmarkType;
    id: string;
  }[];
  const out: Record<BookmarkType, string[]> = { show: [], episode: [], snip: [] };
  for (const r of rows) out[r.t].push(r.id);
  return out;
}

export interface TimelineEntry {
  kind: "favorite" | "bookmark";
  type: BookmarkType;
  id: string;
  date: string | null;
  startSec: number | null;
  title: string;
  subtitle: string;
  /** Show and episode kept separate: the row leads with the podcast, and
   *  splitting the combined subtitle in the UI would break on titles with
   *  dashes in them. */
  showTitle: string | null;
  episodeTitle: string | null;
  quoteText: string | null;
  /** Only the opening of the note — enough for the collapsed preview. The
   *  whole thing is fetched on demand when a row is expanded, so shipping it
   *  here would send megabytes to render a few lines. */
  summaryMd: string | null;
  episodeId: string | null;
  showId: string | null;
  shareUrl: string | null;
  starredAt: string | null; // bookmark creation time; null for Snipd favorites
  missingFromVault: boolean;
  tags: string[];
}

const SNIPD_FAV_SQL = `
  SELECT 'favorite' AS kind, 'snip' AS type, s.id, e.last_snip_date AS date, s.start_sec AS startSec,
         COALESCE(s.title, '(untitled snip)') AS title,
         sh.title || ' — ' || e.title AS subtitle,
         sh.title AS showTitle, e.title AS episodeTitle,
         s.quote_text AS quoteText, substr(s.summary_md, 1, ${PREVIEW_CHARS}) AS summaryMd,
         e.id AS episodeId, sh.id AS showId,
         s.share_url AS shareUrl, NULL AS starredAt, s.archived AS missingFromVault,
         s.tags_json AS tagsJson
  FROM snips s
  JOIN episodes e ON e.id = s.episode_id
  JOIN shows sh ON sh.id = e.show_id
  WHERE s.favorited = 1`;

type RawEntry = Omit<TimelineEntry, "missingFromVault" | "tags"> & {
  missingFromVault: number;
  tagsJson: string | null;
};

const toEntry = ({ tagsJson, ...r }: RawEntry): TimelineEntry => ({
  ...r,
  missingFromVault: !!r.missingFromVault,
  tags: parseTags(tagsJson),
});

/** Snips favorited ⭐ inside the Snipd app, in chronological order. */
export function snipdFavoritesTimeline(
  db: DatabaseSync,
  opts: { show?: string; order?: "asc" | "desc" } = {}
): TimelineEntry[] {
  const rows = db.prepare(SNIPD_FAV_SQL).all() as unknown as RawEntry[];
  let out = rows.map(toEntry);
  if (opts.show) out = out.filter((r) => r.showId === opts.show);
  const dir = opts.order === "asc" ? 1 : -1;
  return out.sort(
    (a, b) => dir * ((a.date ?? "").localeCompare(b.date ?? "") || (a.startSec ?? -1) - (b.startSec ?? -1))
  );
}

/** In-app bookmarks (all levels) in chronological order (§4.5). */
export function bookmarksTimeline(
  db: DatabaseSync,
  opts: { type?: BookmarkType; show?: string; order?: "asc" | "desc" } = {}
): TimelineEntry[] {
  const rows = db
    .prepare(
      `SELECT 'bookmark' AS kind, 'snip' AS type, s.id, e.last_snip_date AS date, s.start_sec AS startSec,
              COALESCE(s.title,'(untitled snip)') AS title,
              sh.title || ' — ' || e.title AS subtitle,
              sh.title AS showTitle, e.title AS episodeTitle,
              s.quote_text AS quoteText, substr(s.summary_md, 1, ${PREVIEW_CHARS}) AS summaryMd,
              e.id AS episodeId, sh.id AS showId,
              s.share_url AS shareUrl, f.created_at AS starredAt, s.archived AS missingFromVault,
              s.tags_json AS tagsJson
       FROM bookmarks f
       JOIN snips s ON f.entity_type = 'snip' AND f.entity_id = s.id
       JOIN episodes e ON e.id = s.episode_id
       JOIN shows sh ON sh.id = e.show_id
       UNION ALL
       SELECT 'bookmark', 'episode', e.id, e.last_snip_date, NULL,
              e.title, sh.title, sh.title, e.title, NULL, NULL, e.id, sh.id, e.url, f.created_at, e.archived, NULL
       FROM bookmarks f
       JOIN episodes e ON f.entity_type = 'episode' AND f.entity_id = e.id
       JOIN shows sh ON sh.id = e.show_id
       UNION ALL
       SELECT 'bookmark', 'show', sh.id, date(f.created_at), NULL,
              sh.title, 'show bookmarked this day', sh.title, NULL, NULL, NULL, NULL, sh.id, sh.url, f.created_at, 0, NULL
       FROM bookmarks f
       JOIN shows sh ON f.entity_type = 'show' AND f.entity_id = sh.id`
    )
    .all() as unknown as RawEntry[];

  let filtered = rows.map(toEntry);
  if (opts.type) filtered = filtered.filter((r) => r.type === opts.type);
  if (opts.show) filtered = filtered.filter((r) => r.showId === opts.show);
  const dir = opts.order === "asc" ? 1 : -1;
  return filtered.sort(
    (a, b) => dir * ((a.date ?? "").localeCompare(b.date ?? "") || (a.startSec ?? -1) - (b.startSec ?? -1))
  );
}
