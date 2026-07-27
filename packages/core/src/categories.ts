import type { DatabaseSync } from "node:sqlite";
import { loadVectors, listTopics, topicSnips, type VectorSet } from "./clusters.ts";

/**
 * Categories (Phase 4). Topics are *discovered* and thrown away on every
 * rebuild; categories are *owned* — seeded from topics, then renamed, merged,
 * corrected and kept. Assignment is centroid cosine, multi-label, and manual
 * decisions always win over the automatic ones.
 */
export const DEFAULT_THRESHOLD = 0.42;
/**
 * Multi-label, but not unlimited. On a thematically uniform library (one
 * person's podcasts are *about* something) almost everything clears a fixed
 * cosine bar — the first real run produced 730k assignments, 23 categories per
 * snip, which is the same as no categories at all. Each snip keeps only its
 * best few matches.
 */
export const DEFAULT_MAX_PER_SNIP = 3;

export interface Category {
  id: number;
  name: string;
  note: string | null;
  source: string;
  size: number;
  manual: number;
  shows: number;
  favorites: number;
}

export function listCategories(db: DatabaseSync): Category[] {
  return db
    .prepare(
      `SELECT c.id, c.name, c.note, c.source,
              COUNT(cs.snip_id) AS size,
              SUM(cs.manual) AS manual,
              COUNT(DISTINCT e.show_id) AS shows,
              SUM(CASE WHEN s.favorited = 1 THEN 1 ELSE 0 END) AS favorites
       FROM categories c
       LEFT JOIN category_snips cs ON cs.category_id = c.id
       LEFT JOIN snips s ON s.id = cs.snip_id
       LEFT JOIN episodes e ON e.id = s.episode_id
       GROUP BY c.id ORDER BY size DESC, c.name`
    )
    .all()
    .map((r) => {
      const row = r as unknown as Category;
      return { ...row, manual: row.manual ?? 0, favorites: row.favorites ?? 0 };
    });
}

export function createCategory(db: DatabaseSync, name: string, note?: string): number {
  const res = db
    .prepare("INSERT INTO categories (name, note, source) VALUES (?, ?, 'user')")
    .run(name.trim(), note ?? null);
  return Number(res.lastInsertRowid);
}

export function renameCategory(db: DatabaseSync, id: number, name: string, note?: string | null): void {
  db.prepare("UPDATE categories SET name = ?, note = COALESCE(?, note) WHERE id = ?").run(name.trim(), note ?? null, id);
}

export function deleteCategory(db: DatabaseSync, id: number): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM category_snips WHERE category_id = ?").run(id);
    db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Fold `fromId` into `intoId`, keeping the strongest score per snip. */
export function mergeCategories(db: DatabaseSync, fromId: number, intoId: number): void {
  if (fromId === intoId) return;
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO category_snips (category_id, snip_id, score, manual)
       SELECT ?, snip_id, score, manual FROM category_snips WHERE category_id = ?
       ON CONFLICT(category_id, snip_id) DO UPDATE SET
         score = MAX(score, excluded.score),
         manual = MAX(manual, excluded.manual)`
    ).run(intoId, fromId);
    db.prepare("DELETE FROM category_snips WHERE category_id = ?").run(fromId);
    db.prepare("DELETE FROM categories WHERE id = ?").run(fromId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** A user correction: pin a snip into a category, or pull it out for good. */
export function setCategorySnip(db: DatabaseSync, categoryId: number, snipId: string, member: boolean): void {
  if (member)
    db.prepare(
      `INSERT INTO category_snips (category_id, snip_id, score, manual) VALUES (?, ?, 1.0, 1)
       ON CONFLICT(category_id, snip_id) DO UPDATE SET manual = 1, score = 1.0`
    ).run(categoryId, snipId);
  else db.prepare("DELETE FROM category_snips WHERE category_id = ? AND snip_id = ?").run(categoryId, snipId);
}

function centroidOf(vs: VectorSet, index: Map<string, number>, ids: string[]): Float32Array | null {
  const acc = new Float32Array(vs.dim);
  let n = 0;
  for (const id of ids) {
    const i = index.get(id);
    if (i === undefined) continue;
    for (let d = 0; d < vs.dim; d++) acc[d] += vs.data[i * vs.dim + d];
    n++;
  }
  if (n === 0) return null;
  let norm = 0;
  for (let d = 0; d < vs.dim; d++) norm += acc[d] ** 2;
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < vs.dim; d++) acc[d] /= norm;
  return acc;
}

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function fromBlob(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

/** One category per discovered topic, named after it — the starting taxonomy. */
export function seedCategoriesFromTopics(db: DatabaseSync): { created: number } {
  const topics = listTopics(db);
  const vs = loadVectors(db);
  const index = new Map(vs.ids.map((id, i) => [id, i]));
  let created = 0;
  for (const t of topics) {
    const exists = db.prepare("SELECT id FROM categories WHERE name = ?").get(t.label) as { id: number } | undefined;
    if (exists) continue;
    const id = Number(
      db.prepare("INSERT INTO categories (name, source) VALUES (?, 'seeded')").run(t.label).lastInsertRowid
    );
    // Seed members = the topic's most central snips; assignment expands from there.
    const { ids } = topicSnips(db, t.id, { limit: 50 });
    const ins = db.prepare("INSERT OR IGNORE INTO category_snips (category_id, snip_id, score, manual) VALUES (?, ?, 1.0, 0)");
    for (const snipId of ids) ins.run(id, snipId);
    const centroid = centroidOf(vs, index, ids);
    if (centroid) db.prepare("UPDATE categories SET centroid = ? WHERE id = ?").run(toBlob(centroid), id);
    created++;
  }
  return { created };
}

export interface AssignResult {
  categories: number;
  assignments: number;
  skipped: number;
}

/**
 * Re-assign every snip: cosine against each category's centroid, multi-label
 * above the threshold. Manual memberships are preserved and also define the
 * centroid, so corrections steer future assignment (§4.7).
 */
export function assignCategories(
  db: DatabaseSync,
  opts: { threshold?: number; maxPerSnip?: number; onProgress?: (done: number, total: number) => void } = {}
): AssignResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxPerSnip = opts.maxPerSnip ?? DEFAULT_MAX_PER_SNIP;
  const vs = loadVectors(db);
  if (vs.ids.length === 0) return { categories: 0, assignments: 0, skipped: 0 };
  const index = new Map(vs.ids.map((id, i) => [id, i]));

  const cats = db.prepare("SELECT id, centroid FROM categories").all() as unknown as {
    id: number;
    centroid: Uint8Array | null;
  }[];
  const centroids: { id: number; vec: Float32Array }[] = [];
  let skipped = 0;
  for (const c of cats) {
    // What the category means, in order of authority: snips the user pinned,
    // then its current members, then the stored definition from last time. The
    // stored fallback is what lets a too-strict cutoff be undone by re-running
    // with a lower one.
    const manual = (
      db.prepare("SELECT snip_id FROM category_snips WHERE category_id = ? AND manual = 1").all(c.id) as unknown as {
        snip_id: string;
      }[]
    ).map((r) => r.snip_id);
    const seedIds =
      manual.length > 0
        ? manual
        : (
            db
              .prepare("SELECT snip_id FROM category_snips WHERE category_id = ? ORDER BY score DESC LIMIT 100")
              .all(c.id) as unknown as { snip_id: string }[]
          ).map((r) => r.snip_id);
    const vec = centroidOf(vs, index, seedIds) ?? (c.centroid ? fromBlob(c.centroid) : null);
    if (!vec) {
      skipped++; // a brand-new empty category has nothing to match on yet
      continue;
    }
    db.prepare("UPDATE categories SET centroid = ? WHERE id = ?").run(toBlob(vec), c.id);
    centroids.push({ id: c.id, vec });
  }
  if (centroids.length === 0) return { categories: 0, assignments: 0, skipped };

  const manualRows = db.prepare("SELECT category_id, snip_id FROM category_snips WHERE manual = 1").all() as unknown as {
    category_id: number;
    snip_id: string;
  }[];

  let assignments = 0;
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM category_snips WHERE manual = 0").run();
    const ins = db.prepare(
      "INSERT INTO category_snips (category_id, snip_id, score, manual) VALUES (?, ?, ?, 0) ON CONFLICT DO NOTHING"
    );
    const manualPairs = new Set(manualRows.map((r) => `${r.category_id}:${r.snip_id}`));
    for (let i = 0; i < vs.ids.length; i++) {
      const off = i * vs.dim;
      const matches: { id: number; sim: number }[] = [];
      for (const c of centroids) {
        let sim = 0;
        for (let d = 0; d < vs.dim; d++) sim += vs.data[off + d] * c.vec[d];
        if (sim >= threshold && !manualPairs.has(`${c.id}:${vs.ids[i]}`)) matches.push({ id: c.id, sim });
      }
      matches.sort((a, b) => b.sim - a.sim);
      for (const m of matches.slice(0, maxPerSnip)) {
        ins.run(m.id, vs.ids[i], +m.sim.toFixed(4));
        assignments++;
      }
      if (i % 2000 === 0) opts.onProgress?.(i, vs.ids.length);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  opts.onProgress?.(vs.ids.length, vs.ids.length);
  return { categories: centroids.length, assignments, skipped };
}

/** Snips in a category, best match first. */
export function categorySnips(
  db: DatabaseSync,
  id: number,
  opts: { limit?: number; offset?: number } = {}
): { ids: string[]; total: number } {
  const total = (
    db.prepare("SELECT COUNT(*) c FROM category_snips WHERE category_id = ?").get(id) as { c: number }
  ).c;
  const rows = db
    .prepare(
      "SELECT snip_id FROM category_snips WHERE category_id = ? ORDER BY manual DESC, score DESC LIMIT ? OFFSET ?"
    )
    .all(id, opts.limit ?? 25, opts.offset ?? 0) as unknown as { snip_id: string }[];
  return { ids: rows.map((r) => r.snip_id), total };
}

/** Categories a single snip belongs to — shown on snip cards. */
export function snipCategories(db: DatabaseSync, snipId: string): { id: number; name: string; score: number }[] {
  return db
    .prepare(
      `SELECT c.id, c.name, cs.score FROM category_snips cs JOIN categories c ON c.id = cs.category_id
       WHERE cs.snip_id = ? ORDER BY cs.score DESC`
    )
    .all(snipId) as unknown as { id: number; name: string; score: number }[];
}

export function categoriesStatus(db: DatabaseSync): {
  categories: number;
  assigned: number;
  uncategorized: number;
  threshold: number;
  maxPerSnip: number;
} {
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  const assigned = one("SELECT COUNT(DISTINCT snip_id) c FROM category_snips");
  return {
    categories: one("SELECT COUNT(*) c FROM categories"),
    assigned,
    uncategorized: one("SELECT COUNT(*) c FROM snips") - assigned,
    threshold: DEFAULT_THRESHOLD,
    maxPerSnip: DEFAULT_MAX_PER_SNIP,
  };
}
