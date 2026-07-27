import type { DatabaseSync } from "node:sqlite";

/**
 * Tags applied inside the Snipd app. The default plugin snip template ends with
 * {{snip_tags}}, which renders them into the snip heading as [[wiki-links]];
 * the parser stores the raw list on snips.tags_json and this module keeps the
 * normalized `tags` / `snip_tags` projection in sync for filtering and facets.
 *
 * Terminology (owner's, matching Favorites/Bookmarks): "Tags" come from Snipd
 * and are read-only here; tags added inside Resurface are "Labels"
 * (source='user'), reserved for a later phase.
 */
export type TagSource = "snipd" | "user";

/**
 * One tag, one identity: trim, drop a leading #, collapse inner whitespace,
 * lowercase. `To Revisit`, `to revisit` and `#to  revisit` all converge, while
 * the display label keeps the owner's own spelling.
 */
export function normalizeTagKey(raw: string): string {
  return raw.replace(/^\s*#+/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function ensureTag(db: DatabaseSync, label: string, source: TagSource = "snipd"): number | null {
  const key = normalizeTagKey(label);
  if (!key) return null;
  const clean = label.replace(/^\s*#+/, "").replace(/\s+/g, " ").trim();
  db.prepare("INSERT OR IGNORE INTO tags (key, label, source) VALUES (?, ?, ?)").run(key, clean, source);
  return (db.prepare("SELECT id FROM tags WHERE key = ?").get(key) as { id: number }).id;
}

/** Replace a snip's tag rows (the vault is the source of truth for its snips). */
export function setSnipTags(db: DatabaseSync, snipId: string, tags: string[]): void {
  const ids = new Set<number>();
  for (const t of tags) {
    const id = ensureTag(db, t);
    if (id !== null) ids.add(id);
  }
  db.prepare("DELETE FROM snip_tags WHERE snip_id = ?").run(snipId);
  const ins = db.prepare("INSERT OR IGNORE INTO snip_tags (snip_id, tag_id) VALUES (?, ?)");
  for (const id of ids) ins.run(snipId, id);
}

/** One-time fill of the tag tables from the tags_json the parser already wrote. */
export function backfillSnipTags(db: DatabaseSync): number {
  const rows = db
    .prepare("SELECT id, tags_json FROM snips WHERE tags_json IS NOT NULL")
    .all() as unknown as { id: string; tags_json: string }[];
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      let tags: unknown;
      try {
        tags = JSON.parse(r.tags_json);
      } catch {
        continue;
      }
      if (!Array.isArray(tags)) continue;
      setSnipTags(db, r.id, tags.filter((t): t is string => typeof t === "string"));
      n++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return n;
}

export interface TagRow {
  id: number;
  key: string;
  label: string;
  source: TagSource;
  snips: number;
  shows: number;
  episodes: number;
  favorites: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Tagged snips still present in the vault; 0 means the tag is retired. */
  live: number;
}

/**
 * Every tag with its counts. Retired tags (all their snips gone from the vault)
 * are kept — never deleted — and merely hidden unless includeRetired is set.
 */
export function listTags(db: DatabaseSync, opts: { includeRetired?: boolean } = {}): TagRow[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.key, t.label, t.source,
              COUNT(st.snip_id) AS snips,
              COUNT(DISTINCT e.show_id) AS shows,
              COUNT(DISTINCT e.id) AS episodes,
              SUM(CASE WHEN s.favorited = 1 THEN 1 ELSE 0 END) AS favorites,
              MIN(e.last_snip_date) AS firstDate,
              MAX(e.last_snip_date) AS lastDate,
              SUM(CASE WHEN s.archived = 0 THEN 1 ELSE 0 END) AS live
       FROM tags t
       LEFT JOIN snip_tags st ON st.tag_id = t.id
       LEFT JOIN snips s ON s.id = st.snip_id
       LEFT JOIN episodes e ON e.id = s.episode_id
       GROUP BY t.id
       ORDER BY snips DESC, t.label COLLATE NOCASE ASC`
    )
    .all() as unknown as TagRow[];
  const out = rows.map((r) => ({ ...r, favorites: r.favorites ?? 0, live: r.live ?? 0 }));
  return opts.includeRetired ? out : out.filter((r) => r.live > 0 || r.snips > 0);
}

export function getTag(db: DatabaseSync, key: string): TagRow | null {
  const k = normalizeTagKey(key);
  return listTags(db, { includeRetired: true }).find((t) => t.key === k) ?? null;
}

export interface TagSnip {
  id: string;
  title: string | null;
  quoteText: string | null;
  quoteAttribution: string | null;
  summaryMd: string | null;
  startSec: number | null;
  endSec: number | null;
  shareUrl: string | null;
  episodeId: string;
  episodeTitle: string;
  lastSnipDate: string | null;
  showId: string;
  showTitle: string;
  favorited: boolean;
  missingFromVault: boolean;
  tags: string[];
}

/** Snips carrying a tag, newest first by default. */
export function tagSnips(
  db: DatabaseSync,
  key: string,
  opts: { order?: "asc" | "desc"; limit?: number; offset?: number } = {}
): { snips: TagSnip[]; total: number } {
  const k = normalizeTagKey(key);
  const dir = opts.order === "asc" ? "ASC" : "DESC";
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM snip_tags st JOIN tags t ON t.id = st.tag_id WHERE t.key = ?`
      )
      .get(k) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.quote_text AS quoteText, s.quote_attribution AS quoteAttribution,
              s.summary_md AS summaryMd, s.start_sec AS startSec, s.end_sec AS endSec,
              s.share_url AS shareUrl, s.favorited, s.archived AS missingFromVault, s.tags_json AS tagsJson,
              e.id AS episodeId, e.title AS episodeTitle, e.last_snip_date AS lastSnipDate,
              sh.id AS showId, sh.title AS showTitle
       FROM snip_tags st
       JOIN tags t ON t.id = st.tag_id
       JOIN snips s ON s.id = st.snip_id
       JOIN episodes e ON e.id = s.episode_id
       JOIN shows sh ON sh.id = e.show_id
       WHERE t.key = ?
       ORDER BY e.last_snip_date ${dir}, s.start_sec ASC
       LIMIT ? OFFSET ?`
    )
    .all(k, opts.limit ?? 50, opts.offset ?? 0) as unknown as (Omit<
    TagSnip,
    "favorited" | "missingFromVault" | "tags"
  > & { favorited: number; missingFromVault: number; tagsJson: string | null })[];
  return {
    total,
    snips: rows.map(({ tagsJson, ...r }) => ({
      ...r,
      favorited: !!r.favorited,
      missingFromVault: !!r.missingFromVault,
      tags: parseTags(tagsJson),
    })),
  };
}

/** Safe parse of the raw tags_json column. */
export function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** Tag counts within a period, for the dashboard tile. */
export function topTags(
  db: DatabaseSync,
  opts: { from?: string | null; to?: string; limit?: number } = {}
): { key: string; label: string; count: number }[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.from) {
    where.push("e.last_snip_date >= ?");
    params.push(opts.from);
  }
  if (opts.to) {
    where.push("e.last_snip_date <= ?");
    params.push(opts.to);
  }
  return db
    .prepare(
      `SELECT t.key, t.label, COUNT(*) AS count
       FROM snip_tags st
       JOIN tags t ON t.id = st.tag_id
       JOIN snips s ON s.id = st.snip_id
       JOIN episodes e ON e.id = s.episode_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       GROUP BY t.id ORDER BY count DESC, t.label COLLATE NOCASE LIMIT ?`
    )
    .all(...params, opts.limit ?? 8) as unknown as { key: string; label: string; count: number }[];
}
