import type { DatabaseSync } from "node:sqlite";
import { normalizeTagKey, parseTags } from "./tags.ts";

export interface SearchFilters {
  show?: string; // show id
  from?: string; // YYYY-MM-DD (episode last_snip_date)
  to?: string;
  /** Only Snipd-favorited or bookmarked items. */
  starredOnly?: boolean;
  hasQuote?: boolean;
  /** Snipd tag keys; combined per tagMode (default "any"). */
  tags?: string[];
  tagMode?: "any" | "all";
  /**
   * Who made the snip: Snipd's template ("auto") or you ("manual").
   * A filter only — it never changes ranking, on the same principle as tags.
   */
  kind?: "auto" | "manual";
  sort?: "relevance" | "newest" | "oldest";
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  id: string;
  title: string | null;
  quoteText: string | null;
  quoteAttribution: string | null;
  summaryMd: string | null;
  transcriptSnippet: string | null;
  startSec: number | null;
  endSec: number | null;
  shareUrl: string | null;
  episodeId: string;
  episodeTitle: string;
  lastSnipDate: string | null;
  showId: string;
  showTitle: string;
  favorited: boolean; // ⭐ from the Snipd app
  bookmarkSnip: boolean;
  bookmarkEpisode: boolean;
  bookmarkShow: boolean;
  missingFromVault: boolean;
  tags: string[];
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  tookMs: number;
  query: string;
}

/**
 * Turn free text into a safe FTS5 MATCH expression: each token becomes a quoted
 * phrase (AND semantics); the final token prefix-matches for search-as-you-type.
 */
export function buildMatchQuery(q: string): string | null {
  const endsWithSpace = /\s$/.test(q);
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["*^]/g, "").trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens
    .map((t, i) => (i === tokens.length - 1 && !endsWithSpace ? `"${t}" *` : `"${t}"`))
    .join(" ");
}

/**
 * Star-boosted BM25 ranking. bm25() returns negative values (more negative =
 * better), so multiplying by a boost ≥ 1 promotes starred items. Snipd ⭐
 * favorites and in-app snip bookmarks weigh the same; boosts multiply across
 * levels and cap at ×2 (§4.3 of the plan). Tags deliberately don't boost — a
 * tag organizes, it doesn't endorse.
 */
const BOOST_SQL = `
  MIN(2.0,
    (CASE WHEN s.favorited = 1 OR fs.entity_id IS NOT NULL THEN 1.5 ELSE 1.0 END) *
    (CASE WHEN fe.entity_id IS NOT NULL THEN 1.25 ELSE 1.0 END) *
    (CASE WHEN fsh.entity_id IS NOT NULL THEN 1.1 ELSE 1.0 END))`;

/**
 * Pull `tag:ideas` / `tag:"to revisit"` terms out of the raw query so power
 * typing works without touching the filter bar. Returns the remaining text.
 */
export function extractTagTerms(q: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  const text = q.replace(/(?:^|\s)tag:(?:"([^"]*)"|'([^']*)'|(\S+))/gi, (_m, dq, sq, bare) => {
    const key = normalizeTagKey(dq ?? sq ?? bare ?? "");
    if (key) tags.push(key);
    return " ";
  });
  return { text, tags };
}

/** Tag EXISTS clause honoring any/all semantics. */
function tagWhere(tags: string[], mode: "any" | "all" | undefined, params: (string | number)[]): string {
  const keys = [...new Set(tags.map(normalizeTagKey).filter(Boolean))];
  if (keys.length === 0) return "";
  const inList = keys.map(() => "?").join(", ");
  params.push(...keys);
  if (mode === "all") {
    params.push(keys.length);
    return `(SELECT COUNT(DISTINCT t.key) FROM snip_tags st JOIN tags t ON t.id = st.tag_id
             WHERE st.snip_id = s.id AND t.key IN (${inList})) = ?`;
  }
  return `EXISTS (SELECT 1 FROM snip_tags st JOIN tags t ON t.id = st.tag_id
           WHERE st.snip_id = s.id AND t.key IN (${inList}))`;
}

/** Shared FROM/WHERE builder so search, counts and facets stay in lockstep. */
function buildQuery(q: string, filters: SearchFilters) {
  const { text, tags: inlineTags } = extractTagTerms(q);
  const tags = [...(filters.tags ?? []), ...inlineTags];
  const match = buildMatchQuery(text);
  // Note: no archived filter — snips missing from the vault stay searchable
  // forever (never-delete policy); hits carry a missingFromVault flag instead.
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (match) {
    where.push("snips_fts MATCH ?");
    params.push(match);
  }
  if (filters.show) {
    where.push("sh.id = ?");
    params.push(filters.show);
  }
  if (filters.from) {
    where.push("e.last_snip_date >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    where.push("e.last_snip_date <= ?");
    params.push(filters.to);
  }
  if (filters.hasQuote) where.push("s.quote_text IS NOT NULL");
  if (filters.kind) {
    where.push("s.kind = ?");
    params.push(filters.kind);
  }
  if (filters.starredOnly)
    where.push(
      "(s.favorited = 1 OR fs.entity_id IS NOT NULL OR fe.entity_id IS NOT NULL OR fsh.entity_id IS NOT NULL)"
    );
  const tagClause = tagWhere(tags, filters.tagMode, params);
  if (tagClause) where.push(tagClause);

  // With no text query (e.g. tag-only browsing) the FTS table drops out of the
  // join entirely, so tags alone can drive a result list.
  const joins = `
    FROM ${match ? "snips_fts JOIN snips s ON s.rowid = snips_fts.rowid" : "snips s"}
    JOIN episodes e ON e.id = s.episode_id
    JOIN shows sh ON sh.id = e.show_id
    LEFT JOIN bookmarks fs ON fs.entity_type = 'snip' AND fs.entity_id = s.id
    LEFT JOIN bookmarks fe ON fe.entity_type = 'episode' AND fe.entity_id = e.id
    LEFT JOIN bookmarks fsh ON fsh.entity_type = 'show' AND fsh.entity_id = sh.id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  return { joins, params, match, tags, hasFilter: where.length > 0 };
}

export function searchSnips(db: DatabaseSync, q: string, filters: SearchFilters = {}): SearchResult {
  const t0 = performance.now();
  const { joins, params, match, hasFilter } = buildQuery(q, filters);
  if (!hasFilter) return { hits: [], total: 0, tookMs: 0, query: q };

  const order =
    filters.sort === "newest" || (!match && filters.sort !== "oldest")
      ? "ORDER BY e.last_snip_date DESC, s.start_sec ASC"
      : filters.sort === "oldest"
        ? "ORDER BY e.last_snip_date ASC, s.start_sec ASC"
        : `ORDER BY bm25(snips_fts, 4.0, 2.0, 2.0, 1.0) * ${BOOST_SQL} ASC`;

  const total = (db.prepare(`SELECT COUNT(*) c ${joins}`).get(...params) as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.quote_text AS quoteText, s.quote_attribution AS quoteAttribution,
              s.summary_md AS summaryMd, s.start_sec AS startSec, s.end_sec AS endSec,
              s.share_url AS shareUrl, s.tags_json AS tagsJson,
              ${match ? "snippet(snips_fts, 3, '<mark>', '</mark>', ' … ', 14)" : "NULL"} AS transcriptSnippet,
              e.id AS episodeId, e.title AS episodeTitle, e.last_snip_date AS lastSnipDate,
              sh.id AS showId, sh.title AS showTitle,
              s.favorited AS favorited,
              (fs.entity_id IS NOT NULL) AS bookmarkSnip,
              (fe.entity_id IS NOT NULL) AS bookmarkEpisode,
              (fsh.entity_id IS NOT NULL) AS bookmarkShow,
              s.archived AS missingFromVault
       ${joins} ${order} LIMIT ? OFFSET ?`
    )
    .all(...params, filters.limit ?? 25, filters.offset ?? 0) as unknown as (Omit<
    SearchHit,
    "favorited" | "bookmarkSnip" | "bookmarkEpisode" | "bookmarkShow" | "missingFromVault" | "tags"
  > & {
    favorited: number;
    bookmarkSnip: number;
    bookmarkEpisode: number;
    bookmarkShow: number;
    missingFromVault: number;
    tagsJson: string | null;
  })[];

  return {
    hits: rows.map(({ tagsJson, ...r }) => ({
      ...r,
      favorited: !!r.favorited,
      bookmarkSnip: !!r.bookmarkSnip,
      bookmarkEpisode: !!r.bookmarkEpisode,
      bookmarkShow: !!r.bookmarkShow,
      missingFromVault: !!r.missingFromVault,
      tags: parseTags(tagsJson),
    })),
    total,
    tookMs: Math.round((performance.now() - t0) * 10) / 10,
    query: q,
  };
}

/**
 * How many of the current results each tag would keep — the sidebar counts.
 * Computed with the same WHERE as the search itself, minus its own tag filter,
 * so the numbers describe what clicking a chip would do.
 */
export function tagFacets(
  db: DatabaseSync,
  q: string,
  filters: SearchFilters = {},
  limit = 20
): { key: string; label: string; count: number }[] {
  const { joins, params, hasFilter } = buildQuery(q, { ...filters, tags: [], tagMode: undefined });
  if (!hasFilter) return [];
  return db
    .prepare(
      `SELECT t.key, t.label, COUNT(*) AS count
       FROM snip_tags st JOIN tags t ON t.id = st.tag_id
       WHERE st.snip_id IN (SELECT s.id ${joins})
       GROUP BY t.id ORDER BY count DESC, t.label COLLATE NOCASE LIMIT ?`
    )
    .all(...params, limit) as unknown as { key: string; label: string; count: number }[];
}

export interface SavedSearch {
  id: number;
  name: string;
  query: { q: string; filters: SearchFilters };
  createdAt: string;
  lastSeenAt: string | null;
  newCount: number;
}

export function listSavedSearches(db: DatabaseSync): SavedSearch[] {
  const rows = db
    .prepare("SELECT id, name, query_json, created_at, last_seen_at FROM saved_searches ORDER BY id")
    .all() as unknown as { id: number; name: string; query_json: string; created_at: string; last_seen_at: string | null }[];
  return rows.map((r) => {
    const query = JSON.parse(r.query_json) as { q: string; filters: SearchFilters };
    let newCount = 0;
    if (r.last_seen_at) {
      const since = r.last_seen_at.slice(0, 10);
      newCount = searchSnips(db, query.q, { ...query.filters, from: since, limit: 1 }).total;
    }
    return { id: r.id, name: r.name, query, createdAt: r.created_at, lastSeenAt: r.last_seen_at, newCount };
  });
}

export function createSavedSearch(db: DatabaseSync, name: string, q: string, filters: SearchFilters): number {
  const res = db
    .prepare("INSERT INTO saved_searches (name, query_json, last_seen_at) VALUES (?, ?, datetime('now'))")
    .run(name, JSON.stringify({ q, filters }));
  return Number(res.lastInsertRowid);
}

export function touchSavedSearch(db: DatabaseSync, id: number): void {
  db.prepare("UPDATE saved_searches SET last_seen_at = datetime('now') WHERE id = ?").run(id);
}

export function deleteSavedSearch(db: DatabaseSync, id: number): void {
  db.prepare("DELETE FROM saved_searches WHERE id = ?").run(id);
}
