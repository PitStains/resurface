import type { DatabaseSync } from "node:sqlite";
import { getVector, nearest, type Embedder, type Neighbor } from "./embeddings.ts";
import { searchSnips, type SearchFilters, type SearchHit, type SearchResult } from "./search.ts";
import { parseTags } from "./tags.ts";

const HIT_COLUMNS = `
  SELECT s.id, s.title, s.quote_text AS quoteText, s.quote_attribution AS quoteAttribution,
         s.summary_md AS summaryMd, s.start_sec AS startSec, s.end_sec AS endSec,
         s.share_url AS shareUrl, s.tags_json AS tagsJson, NULL AS transcriptSnippet,
         e.id AS episodeId, e.title AS episodeTitle, e.last_snip_date AS lastSnipDate,
         sh.id AS showId, sh.title AS showTitle, s.favorited,
         (fs.entity_id IS NOT NULL) AS bookmarkSnip,
         (fe.entity_id IS NOT NULL) AS bookmarkEpisode,
         (fsh.entity_id IS NOT NULL) AS bookmarkShow,
         s.archived AS missingFromVault
  FROM snips s
  JOIN episodes e ON e.id = s.episode_id
  JOIN shows sh ON sh.id = e.show_id
  LEFT JOIN bookmarks fs ON fs.entity_type = 'snip' AND fs.entity_id = s.id
  LEFT JOIN bookmarks fe ON fe.entity_type = 'episode' AND fe.entity_id = e.id
  LEFT JOIN bookmarks fsh ON fsh.entity_type = 'show' AND fsh.entity_id = sh.id`;

type RawHit = Omit<
  SearchHit,
  "favorited" | "bookmarkSnip" | "bookmarkEpisode" | "bookmarkShow" | "missingFromVault" | "tags"
> & {
  favorited: number;
  bookmarkSnip: number;
  bookmarkEpisode: number;
  bookmarkShow: number;
  missingFromVault: number;
  tagsJson: string | null;
};

const toHit = ({ tagsJson, ...r }: RawHit): SearchHit => ({
  ...r,
  favorited: !!r.favorited,
  bookmarkSnip: !!r.bookmarkSnip,
  bookmarkEpisode: !!r.bookmarkEpisode,
  bookmarkShow: !!r.bookmarkShow,
  missingFromVault: !!r.missingFromVault,
  tags: parseTags(tagsJson),
});

/** Load snips by id, preserving the given order (ranking lives in the caller). */
export function hydrateSnips(db: DatabaseSync, ids: string[]): SearchHit[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(`${HIT_COLUMNS} WHERE s.id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as unknown as RawHit[];
  const byId = new Map(rows.map((r) => [r.id, toHit(r)]));
  return ids.map((id) => byId.get(id)).filter((h): h is SearchHit => !!h);
}

export interface SnipDetail extends SearchHit {
  /** The full transcript, which the list endpoints deliberately omit. */
  transcriptMd: string | null;
  kind: string;
  durationSec: number | null;
}

/**
 * Everything about one snip, for reading it in place. Lists stay lightweight —
 * a transcript can run to thousands of characters and there is no reason to
 * ship 25 of them to render a page — so this is fetched only when a reader
 * actually opens one.
 */
export function snipDetail(db: DatabaseSync, id: string): SnipDetail | null {
  const row = db
    .prepare(
      `${HIT_COLUMNS.replace("NULL AS transcriptSnippet", "NULL AS transcriptSnippet, s.transcript_md AS transcriptMd, s.kind, s.duration_sec AS durationSec")}
       WHERE s.id = ?`
    )
    .get(id) as unknown as (RawHit & { transcriptMd: string | null; kind: string; durationSec: number | null }) | undefined;
  if (!row) return null;
  const { transcriptMd, kind, durationSec, ...rest } = row;
  return { ...toHit(rest as RawHit), transcriptMd, kind, durationSec };
}

/** Restrict candidate ids to those matching the non-text filters. */
function applyFilters(db: DatabaseSync, ids: string[], filters: SearchFilters): Set<string> {
  if (ids.length === 0) return new Set();
  const where: string[] = [`s.id IN (${ids.map(() => "?").join(",")})`];
  const params: (string | number)[] = [...ids];
  if (filters.show) {
    where.push("e.show_id = ?");
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
      `(s.favorited = 1 OR EXISTS (SELECT 1 FROM bookmarks b WHERE b.entity_type = 'snip' AND b.entity_id = s.id))`
    );
  const tags = (filters.tags ?? []).filter(Boolean);
  if (tags.length > 0) {
    const inList = tags.map(() => "?").join(",");
    params.push(...tags);
    if (filters.tagMode === "all") {
      params.push(tags.length);
      where.push(
        `(SELECT COUNT(DISTINCT t.key) FROM snip_tags st JOIN tags t ON t.id = st.tag_id
          WHERE st.snip_id = s.id AND t.key IN (${inList})) = ?`
      );
    } else {
      where.push(
        `EXISTS (SELECT 1 FROM snip_tags st JOIN tags t ON t.id = st.tag_id
          WHERE st.snip_id = s.id AND t.key IN (${inList}))`
      );
    }
  }
  const rows = db
    .prepare(`SELECT s.id FROM snips s JOIN episodes e ON e.id = s.episode_id WHERE ${where.join(" AND ")}`)
    .all(...params) as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export interface RelatedSnip extends SearchHit {
  score: number;
}

/**
 * Snips that mean something similar, by vector neighborhood. Other snips from
 * the same episode are excluded — they're already on screen together, and
 * neighbors from elsewhere are what make this useful.
 */
export function relatedSnips(db: DatabaseSync, snipId: string, k = 6): RelatedSnip[] {
  const vec = getVector(db, snipId);
  if (!vec) return [];
  const siblings = db
    .prepare("SELECT id FROM snips WHERE episode_id = (SELECT episode_id FROM snips WHERE id = ?)")
    .all(snipId) as unknown as { id: string }[];
  const neighbors = nearest(db, vec, k, new Set(siblings.map((s) => s.id)));
  const hits = hydrateSnips(db, neighbors.map((n) => n.id));
  const scores = new Map(neighbors.map((n) => [n.id, n.score]));
  return hits.map((h) => ({ ...h, score: +(scores.get(h.id) ?? 0).toFixed(3) }));
}

/** Meaning-only search: no shared words required. */
export async function semanticSearch(
  db: DatabaseSync,
  q: string,
  embedder: Embedder,
  filters: SearchFilters = {},
  limit = 25
): Promise<SearchResult> {
  const t0 = performance.now();
  if (!q.trim()) return { hits: [], total: 0, tookMs: 0, query: q };
  const [vec] = await embedder([q]);
  const pool = Math.max(limit * 4, 100);
  const neighbors = nearest(db, vec, pool);
  const allowed = applyFilters(db, neighbors.map((n) => n.id), filters);
  const matching = neighbors.filter((n) => allowed.has(n.id));
  return {
    hits: hydrateSnips(db, matching.slice(0, limit).map((n) => n.id)),
    // The closest `pool` snips are ranked; "total" is how many of those survived
    // the filters, not a corpus-wide count — meaning-ranking has no cutoff, so
    // every snip is technically a match at some distance.
    total: matching.length,
    tookMs: Math.round((performance.now() - t0) * 10) / 10,
    query: q,
  };
}

/** Reciprocal-rank-fusion constant; 60 is the value from the original paper. */
const RRF_K = 60;

/**
 * Hybrid search: keyword and meaning, fused by reciprocal rank. Neither list
 * dominates, so exact-phrase hits keep their edge while snips that never use
 * your words still surface. Stars keep boosting, as in keyword mode.
 */
export async function hybridSearch(
  db: DatabaseSync,
  q: string,
  embedder: Embedder,
  filters: SearchFilters = {}
): Promise<SearchResult & { keywordTotal: number }> {
  const t0 = performance.now();
  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;
  const pool = Math.max(100, (limit + offset) * 4);

  const keyword = searchSnips(db, q, { ...filters, limit: pool, offset: 0, sort: "relevance" });
  let semantic: Neighbor[] = [];
  if (q.trim()) {
    const [vec] = await embedder([q]);
    const neighbors = nearest(db, vec, pool);
    const allowed = applyFilters(db, neighbors.map((n) => n.id), filters);
    semantic = neighbors.filter((n) => allowed.has(n.id));
  }

  const scores = new Map<string, number>();
  keyword.hits.forEach((h, i) => scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (RRF_K + i + 1)));
  semantic.forEach((n, i) => scores.set(n.id, (scores.get(n.id) ?? 0) + 1 / (RRF_K + i + 1)));

  const starred = new Map(keyword.hits.map((h) => [h.id, h.favorited || h.bookmarkSnip]));
  const ranked = [...scores.entries()]
    .map(([id, score]) => ({ id, score: score * (starred.get(id) ? 1.15 : 1) }))
    .sort((a, b) => b.score - a.score);

  const page = ranked.slice(offset, offset + limit).map((r) => r.id);
  return {
    hits: hydrateSnips(db, page),
    total: ranked.length,
    keywordTotal: keyword.total,
    tookMs: Math.round((performance.now() - t0) * 10) / 10,
    query: q,
  };
}
