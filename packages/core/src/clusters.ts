import type { DatabaseSync } from "node:sqlite";
import { EMBED_MODEL } from "./embeddings.ts";

/**
 * Topics and the map (Phase 3, §4.6). Both are derived from the snip vectors:
 * k-means groups snips by meaning, and a PCA projection places every snip on a
 * 2-D canvas. Everything runs locally in plain TypeScript — no extra
 * dependencies, and the whole thing is rebuildable at any time.
 */

/** Deterministic PRNG so a rebuild on the same data gives the same topics. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface VectorSet {
  ids: string[];
  data: Float32Array; // ids.length × dim, row-major
  dim: number;
}

export function loadVectors(db: DatabaseSync): VectorSet {
  const rows = db
    .prepare("SELECT snip_id, dim, vec FROM snip_vectors WHERE model = ? ORDER BY rowid")
    .all(EMBED_MODEL) as unknown as { snip_id: string; dim: number; vec: Uint8Array }[];
  const dim = rows[0]?.dim ?? 384;
  const data = new Float32Array(rows.length * dim);
  const ids: string[] = [];
  rows.forEach((r, i) => {
    ids.push(r.snip_id);
    const copy = new Uint8Array(r.vec.byteLength);
    copy.set(r.vec);
    data.set(new Float32Array(copy.buffer), i * dim);
  });
  return { ids, data, dim };
}

export interface KMeansResult {
  assignment: Int32Array;
  similarity: Float32Array;
  centroids: Float32Array;
  k: number;
}

/**
 * Spherical k-means: vectors are unit-length, so cosine similarity is a dot
 * product and the centroid update is "mean, then renormalize". k-means++ seeding
 * keeps topics from collapsing onto each other.
 */
export function kmeans(
  vs: VectorSet,
  k: number,
  opts: { iterations?: number; seed?: number; onProgress?: (iter: number, total: number) => void } = {}
): KMeansResult {
  const n = vs.ids.length;
  const { dim, data } = vs;
  const iterations = opts.iterations ?? 12;
  const rand = mulberry32(opts.seed ?? 42);
  k = Math.max(1, Math.min(k, n));

  const centroids = new Float32Array(k * dim);
  const dot = (aOff: number, b: Float32Array, bOff: number) => {
    let s = 0;
    for (let d = 0; d < dim; d++) s += data[aOff + d] * b[bOff + d];
    return s;
  };

  // k-means++ seeding on cosine distance.
  const first = Math.floor(rand() * n);
  centroids.set(data.subarray(first * dim, (first + 1) * dim), 0);
  const best = new Float32Array(n).fill(-1);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const sim = dot(i * dim, centroids, (c - 1) * dim);
      if (sim > best[i]) best[i] = sim;
      sum += Math.max(0, 1 - best[i]) ** 2;
    }
    let target = rand() * sum;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= Math.max(0, 1 - best[i]) ** 2;
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centroids.set(data.subarray(pick * dim, (pick + 1) * dim), c * dim);
  }

  const assignment = new Int32Array(n).fill(-1);
  const similarity = new Float32Array(n);
  for (let iter = 0; iter < iterations; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let bestC = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < k; c++) {
        const sim = dot(i * dim, centroids, c * dim);
        if (sim > bestSim) {
          bestSim = sim;
          bestC = c;
        }
      }
      if (assignment[i] !== bestC) moved++;
      assignment[i] = bestC;
      similarity[i] = bestSim;
    }
    const sums = new Float32Array(k * dim);
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      const c = assignment[i];
      counts[c]++;
      for (let d = 0; d < dim; d++) sums[c * dim + d] += data[i * dim + d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue; // keep the old centroid rather than drift
      let norm = 0;
      for (let d = 0; d < dim; d++) norm += sums[c * dim + d] ** 2;
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dim; d++) centroids[c * dim + d] = sums[c * dim + d] / norm;
    }
    opts.onProgress?.(iter + 1, iterations);
    if (moved === 0) break; // converged
  }
  return { assignment, similarity, centroids, k };
}

/**
 * Filler and export furniture only.
 *
 * An earlier version also hardcoded the vocabulary of one particular subject
 * area, because those words swamped every label in that corpus. That was the
 * wrong lever twice over: it bakes one listener's interests into everyone's
 * install, and it would suppress exactly the words someone studying that
 * subject needs. Corpus-ubiquitous terms are already handled generically —
 * `idf = log(k / df)` drives a word appearing in every topic to zero, and the
 * show-entropy weighting below demotes words confined to a single show.
 */
const STOPWORDS = new Set(
  ("the a an and or but of to in on for with from by as at is are was were be been being this that these those it its his her their our your my we you they he she i not no do does did how what why when where who whom which will would can could should shall may might must about into over under again more most other some such only own same so than too very s t just now says say said one two three four five " +
    // Words the export itself contributes: template headings, and furniture
    // that lands in snip titles ("2min snip"). Naming a topic after the tooling
    // would be worse than useless.
    "title speaker guests summary main theme episode podcast part quote key takeaway takeaways insight insights " +
    "min mins snip snips listeners listener")
    .split(/\s+/)
    .filter(Boolean)
);

/** Shannon entropy of a distribution, in nats. */
function entropy(counts: Iterable<number>): number {
  let total = 0;
  const xs: number[] = [];
  for (const n of counts) {
    if (n > 0) {
      xs.push(n);
      total += n;
    }
  }
  if (total === 0 || xs.length < 2) return 0;
  let h = 0;
  for (const n of xs) {
    const p = n / total;
    h -= p * Math.log(p);
  }
  return h;
}

/**
 * Cluster labels by c-TF-IDF: terms frequent inside one topic and rare across
 * the others. Titles and tags carry the signal; transcripts would drown it.
 *
 * Two corrections keep speakers out of the labels. A host's name is genuinely
 * the most frequent word in their topic, so raw c-TF-IDF names the topic after
 * whoever was talking — correct, and useless, because the snips are not
 * *about* the speaker.
 *
 *  - Names that the export states outright (show authors, guests, book authors,
 *    quote attributions) are excluded, taken from structured fields rather than
 *    guessed at.
 *  - Every term is then weighted by how evenly it is spread across shows,
 *    measured against how evenly its own topic is spread. A term confined to
 *    fewer shows than the topic it labels is describing the show, not the idea
 *    — which also catches catchphrases and sponsor reads, with no name list.
 *    A single-show topic has nothing to compare against, so it is left alone.
 */
export function labelClusters(
  docs: string[],
  assignment: Int32Array,
  k: number,
  termsPerLabel = 3,
  opts: { shows?: string[]; excludeTerms?: Set<string> } = {}
): { label: string; terms: string[] }[] {
  const exclude = opts.excludeTerms ?? new Set<string>();
  const shows = opts.shows;
  const perCluster: Map<string, number>[] = Array.from({ length: k }, () => new Map());
  const clusterTotals = new Int32Array(k);
  // term -> show -> count, and the topic's own show spread, for the entropy test.
  const termShows: Map<string, Map<string, number>>[] = Array.from({ length: k }, () => new Map());
  const clusterShows: Map<string, number>[] = Array.from({ length: k }, () => new Map());

  for (let i = 0; i < docs.length; i++) {
    const c = assignment[i];
    const show = shows?.[i];
    if (show) clusterShows[c].set(show, (clusterShows[c].get(show) ?? 0) + 1);
    for (const raw of docs[i].toLowerCase().split(/[^a-z']+/)) {
      const w = raw.replace(/^'+|'+$/g, "");
      if (w.length < 3 || STOPWORDS.has(w)) continue;
      // A possessive ("Hislop's") has to be excluded by the base name — it is a
      // different token but the same person.
      if (exclude.has(w) || exclude.has(w.replace(/'s$/, ""))) continue;
      perCluster[c].set(w, (perCluster[c].get(w) ?? 0) + 1);
      clusterTotals[c]++;
      if (show) {
        let byShow = termShows[c].get(w);
        if (!byShow) termShows[c].set(w, (byShow = new Map()));
        byShow.set(show, (byShow.get(show) ?? 0) + 1);
      }
    }
  }
  const docFreq = new Map<string, number>();
  for (const m of perCluster) for (const w of m.keys()) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);

  return perCluster.map((m, c) => {
    const topicSpread = entropy(clusterShows[c].values());
    const spreadFactor = (w: string): number => {
      // Nothing to compare against: one show, or no show data at all.
      if (!shows || topicSpread <= 0) return 1;
      const byShow = termShows[c].get(w);
      if (!byShow) return 1;
      return Math.min(1, entropy(byShow.values()) / topicSpread);
    };
    const scored = [...m.entries()]
      .filter(([, n]) => n >= 2)
      // idf = log(k / df): a word that shows up in every topic (a ubiquitous tag
      // like a catch-all tag, or a word common to every episode) scores zero and
      // can never become a label.
      .map(
        ([w, n]) =>
          [w, (n / (clusterTotals[c] || 1)) * Math.log(k / (docFreq.get(w) ?? 1)) * spreadFactor(w)] as const
      )
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1]);
    const terms = scored.slice(0, termsPerLabel).map(([w]) => w);
    const label = terms.length ? terms.map((t) => t[0].toUpperCase() + t.slice(1)).join(" · ") : `Topic ${c + 1}`;
    return { label, terms };
  });
}

/**
 * Every word the export identifies as part of someone's name. Read from
 * structured fields only — show authors, guests, book authors and quote
 * attributions all say "this is a person" explicitly, so no name detection is
 * involved and no other user's vocabulary is assumed.
 */
export function personTerms(db: DatabaseSync): Set<string> {
  const out = new Set<string>();
  const add = (name: string | null) => {
    for (const raw of (name ?? "").toLowerCase().split(/[^a-z']+/)) {
      const w = raw.replace(/^'+|'+$/g, "");
      // Initials and short particles ("de", "van") would over-match real words.
      if (w.length >= 3) out.add(w);
    }
  };
  for (const sql of [
    "SELECT author AS n FROM shows",
    "SELECT name AS n FROM guests",
    "SELECT author AS n FROM books",
    "SELECT DISTINCT quote_attribution AS n FROM snips WHERE quote_attribution IS NOT NULL",
  ])
    for (const r of db.prepare(sql).all() as unknown as { n: string | null }[]) add(r.n);
  return out;
}

/**
 * 2-D layout by PCA (power iteration on the centered vectors). Chosen over UMAP
 * deliberately: it needs no dependency, runs in seconds instead of minutes on
 * 32k points, and is deterministic. Topic colors carry the local structure that
 * PCA alone would flatten.
 */
export function pca2(vs: VectorSet, iterations = 24): { x: Float32Array; y: Float32Array } {
  const { data, dim } = vs;
  const n = vs.ids.length;
  const mean = new Float32Array(dim);
  for (let i = 0; i < n; i++) for (let d = 0; d < dim; d++) mean[d] += data[i * dim + d];
  for (let d = 0; d < dim; d++) mean[d] /= n || 1;

  const project = (v: Float32Array) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let d = 0; d < dim; d++) s += (data[i * dim + d] - mean[d]) * v[d];
      out[i] = s;
    }
    return out;
  };

  const power = (deflate: Float32Array | null) => {
    const rand = mulberry32(7);
    let v = new Float32Array(dim).map(() => rand() - 0.5);
    for (let it = 0; it < iterations; it++) {
      const scores = project(v);
      if (deflate) {
        // Remove the component we already found so the second axis is orthogonal.
        let dp = 0;
        for (let d = 0; d < dim; d++) dp += v[d] * deflate[d];
        for (let d = 0; d < dim; d++) v[d] -= dp * deflate[d];
      }
      const next = new Float32Array(dim);
      for (let i = 0; i < n; i++) {
        const s = scores[i];
        for (let d = 0; d < dim; d++) next[d] += s * (data[i * dim + d] - mean[d]);
      }
      if (deflate) {
        let dp = 0;
        for (let d = 0; d < dim; d++) dp += next[d] * deflate[d];
        for (let d = 0; d < dim; d++) next[d] -= dp * deflate[d];
      }
      let norm = 0;
      for (let d = 0; d < dim; d++) norm += next[d] ** 2;
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dim; d++) next[d] /= norm;
      v = next;
    }
    return v;
  };

  const pc1 = power(null);
  const pc2 = power(pc1);
  const x = project(pc1);
  const y = project(pc2);
  // Normalize to [-1, 1] so the client can scale to any canvas.
  const scale = (a: Float32Array) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of a) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = (hi - lo) / 2 || 1;
    for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) / span - 1;
    return a;
  };
  return { x: scale(x), y: scale(y) };
}

/**
 * Map coordinates. A straight PCA of 384-dim embeddings paints one uniform
 * cloud — mathematically faithful, visually useless. So each snip is placed
 * mostly by where its topic sits and partly by its own position: topics become
 * visible islands, and snips still spread within them.
 */
export function layout(
  vs: VectorSet,
  assignment: Int32Array,
  k: number,
  topicWeight = 0.6
): { x: Float32Array; y: Float32Array } {
  const n = vs.ids.length;
  const own = pca2(vs);
  // Topic anchors = the PCA of each topic's own mean position.
  const cx = new Float64Array(k);
  const cy = new Float64Array(k);
  const counts = new Int32Array(k);
  for (let i = 0; i < n; i++) {
    counts[assignment[i]]++;
    cx[assignment[i]] += own.x[i];
    cy[assignment[i]] += own.y[i];
  }
  for (let c = 0; c < k; c++) {
    if (!counts[c]) continue;
    cx[c] /= counts[c];
    cy[c] /= counts[c];
  }
  // Spread the anchors onto a ring so crowded topics don't overlap; ordering by
  // angle keeps neighbouring topics near each other.
  const order = [...Array(k).keys()].sort((a, b) => Math.atan2(cy[a], cx[a]) - Math.atan2(cy[b], cx[b]));
  const ax = new Float64Array(k);
  const ay = new Float64Array(k);
  order.forEach((c, idx) => {
    const angle = (idx / k) * Math.PI * 2;
    const radius = 0.62 + 0.24 * Math.hypot(cx[c], cy[c]);
    ax[c] = Math.cos(angle) * radius;
    ay[c] = Math.sin(angle) * radius;
  });

  const x = new Float32Array(n);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = assignment[i];
    x[i] = topicWeight * ax[c] + (1 - topicWeight) * own.x[i];
    y[i] = topicWeight * ay[c] + (1 - topicWeight) * own.y[i];
  }
  const rescale = (a: Float32Array) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of a) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = (hi - lo) / 2 || 1;
    for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) / span - 1;
    return a;
  };
  return { x: rescale(x), y: rescale(y) };
}

export interface BuildTopicsResult {
  clusters: number;
  snips: number;
}

/** Rebuild topics + layout from scratch, replacing whatever was there. */
export function buildTopics(
  db: DatabaseSync,
  opts: { k?: number; onProgress?: (phase: string, done: number, total: number) => void } = {}
): BuildTopicsResult {
  const vs = loadVectors(db);
  if (vs.ids.length === 0) return { clusters: 0, snips: 0 };
  // ~1 topic per 900 snips keeps labels specific without a wall of topics.
  const k = opts.k ?? Math.max(6, Math.min(40, Math.round(vs.ids.length / 900)));

  opts.onProgress?.("clustering", 0, 1);
  const { assignment, similarity } = kmeans(vs, k, {
    onProgress: (i, total) => opts.onProgress?.("clustering", i, total),
  });

  const rows = db
    .prepare(
      `SELECT s.id, COALESCE(s.title,'') || ' ' || COALESCE(s.tags_json,'') AS text, e.show_id AS show
       FROM snips s JOIN episodes e ON e.id = s.episode_id`
    )
    .all() as unknown as { id: string; text: string; show: string }[];
  const titles = new Map(rows.map((r) => [r.id, r.text]));
  const showOf = new Map(rows.map((r) => [r.id, r.show]));
  const labels = labelClusters(
    vs.ids.map((id) => titles.get(id) ?? ""),
    assignment,
    k,
    3,
    { shows: vs.ids.map((id) => showOf.get(id) ?? ""), excludeTerms: personTerms(db) }
  );

  opts.onProgress?.("layout", 0, 1);
  const { x, y } = layout(vs, assignment, k);
  opts.onProgress?.("layout", 1, 1);

  const sizes = new Int32Array(k);
  for (const c of assignment) sizes[c]++;

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM snip_clusters; DELETE FROM clusters; DELETE FROM snip_layout;");
    const insCluster = db.prepare(
      "INSERT INTO clusters (id, label, terms_json, size, model) VALUES (?, ?, ?, ?, ?)"
    );
    for (let c = 0; c < k; c++)
      insCluster.run(c, labels[c].label, JSON.stringify(labels[c].terms), sizes[c], EMBED_MODEL);
    const insMember = db.prepare("INSERT INTO snip_clusters (snip_id, cluster_id, similarity) VALUES (?, ?, ?)");
    const insLayout = db.prepare("INSERT INTO snip_layout (snip_id, x, y) VALUES (?, ?, ?)");
    for (let i = 0; i < vs.ids.length; i++) {
      insMember.run(vs.ids[i], assignment[i], similarity[i]);
      insLayout.run(vs.ids[i], x[i], y[i]);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { clusters: k, snips: vs.ids.length };
}

export interface TopicRow {
  id: number;
  label: string;
  terms: string[];
  size: number;
  shows: number;
  favorites: number;
  firstDate: string | null;
  lastDate: string | null;
}

export function listTopics(db: DatabaseSync): TopicRow[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.label, c.terms_json AS termsJson, c.size,
              COUNT(DISTINCT e.show_id) AS shows,
              SUM(CASE WHEN s.favorited = 1 THEN 1 ELSE 0 END) AS favorites,
              MIN(e.last_snip_date) AS firstDate, MAX(e.last_snip_date) AS lastDate
       FROM clusters c
       LEFT JOIN snip_clusters sc ON sc.cluster_id = c.id
       LEFT JOIN snips s ON s.id = sc.snip_id
       LEFT JOIN episodes e ON e.id = s.episode_id
       GROUP BY c.id ORDER BY c.size DESC`
    )
    .all() as unknown as (Omit<TopicRow, "terms"> & { termsJson: string })[];
  return rows.map(({ termsJson, ...r }) => ({
    ...r,
    favorites: r.favorites ?? 0,
    terms: JSON.parse(termsJson) as string[],
  }));
}

/** Snips in a topic, most central first — the best examples of what it means. */
export function topicSnips(
  db: DatabaseSync,
  clusterId: number,
  opts: { limit?: number; offset?: number } = {}
): { ids: string[]; total: number } {
  const total = (
    db.prepare("SELECT COUNT(*) c FROM snip_clusters WHERE cluster_id = ?").get(clusterId) as { c: number }
  ).c;
  const rows = db
    .prepare(
      "SELECT snip_id FROM snip_clusters WHERE cluster_id = ? ORDER BY similarity DESC LIMIT ? OFFSET ?"
    )
    .all(clusterId, opts.limit ?? 25, opts.offset ?? 0) as unknown as { snip_id: string }[];
  return { ids: rows.map((r) => r.snip_id), total };
}

export interface MapPoint {
  id: string;
  x: number;
  y: number;
  c: number;
  f: 0 | 1; // Snipd favorite
}

/** Every placed snip, as compact rows for the canvas. */
export function mapPoints(db: DatabaseSync, opts: { show?: string } = {}): MapPoint[] {
  const where = opts.show ? "WHERE e.show_id = ?" : "";
  const params = opts.show ? [opts.show] : [];
  return db
    .prepare(
      `SELECT l.snip_id AS id, l.x, l.y, COALESCE(sc.cluster_id, -1) AS c, s.favorited AS f
       FROM snip_layout l
       JOIN snips s ON s.id = l.snip_id
       JOIN episodes e ON e.id = s.episode_id
       LEFT JOIN snip_clusters sc ON sc.snip_id = l.snip_id
       ${where}`
    )
    .all(...params) as unknown as MapPoint[];
}

export function topicsStatus(db: DatabaseSync): { clusters: number; placed: number; vectors: number } {
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    clusters: one("SELECT COUNT(*) c FROM clusters"),
    placed: one("SELECT COUNT(*) c FROM snip_layout"),
    vectors: one("SELECT COUNT(*) c FROM snip_vectors"),
  };
}
