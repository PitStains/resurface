import type { DatabaseSync } from "node:sqlite";
import { sha1 } from "./parser.ts";

/**
 * Local semantic layer (Phase 3). Embeddings are computed on this machine with
 * a small ONNX model — no API keys, no data leaving the box, no paid tier.
 * Vectors are derived data: they can be rebuilt from the snips at any time, so
 * the never-delete policy doesn't apply to them.
 */
export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBED_DIM = 384;

/** Injectable so tests (and future model swaps) don't need the real model. */
export type Embedder = (texts: string[]) => Promise<Float32Array[]>;

let cachedEmbedder: Embedder | null = null;

/**
 * The real embedder, loaded lazily: transformers.js pulls ~25 MB of model on
 * first use into %LOCALAPPDATA%\Resurface\models and runs it on the CPU.
 */
export async function localEmbedder(cacheDir?: string, opts: { threads?: number } = {}): Promise<Embedder> {
  if (cachedEmbedder) return cachedEmbedder;
  const { pipeline, env } = await import("@huggingface/transformers");
  if (cacheDir) env.cacheDir = cacheDir;
  // Without a cap ONNX runs on every core and the machine crawls; 0 = let it decide.
  const session_options =
    opts.threads && opts.threads > 0
      ? { intraOpNumThreads: opts.threads, interOpNumThreads: 1, executionMode: "sequential" as const }
      : undefined;
  const extractor = await pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8", session_options });
  cachedEmbedder = async (texts: string[]) => {
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    const flat = out.data as Float32Array;
    return texts.map((_, i) => flat.slice(i * EMBED_DIM, (i + 1) * EMBED_DIM) as Float32Array);
  };
  return cachedEmbedder;
}

export interface EmbeddableSnip {
  id: string;
  title: string | null;
  summary_md: string | null;
  quote_text: string | null;
  transcript_md: string | null;
  show_title: string | null;
  episode_title: string | null;
}

/**
 * What actually gets embedded. Show and episode titles give very short
 * snips enough context to be placed sensibly; the transcript is truncated
 * because the model only reads ~256 word-pieces anyway.
 */
export function embeddingText(s: EmbeddableSnip): string {
  const parts = [
    s.show_title,
    s.episode_title,
    s.title,
    s.quote_text,
    // Strip markdown furniture and list bullets, but keep hyphens inside words
    // ("two-minute rule" shouldn't become two tokens).
    (s.summary_md ?? "")
      .replace(/^[\s>]*[-*+]\s+/gm, " ")
      .replace(/[*_`>#]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    (s.transcript_md ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
  ];
  return parts.filter(Boolean).join(" — ").slice(0, 2000);
}

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function fromBlob(b: Uint8Array): Float32Array {
  // Copy: SQLite's buffer isn't guaranteed aligned or long-lived.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

export interface EmbedProgress {
  done: number;
  total: number;
  startedAt: string;
  finishedAt: string | null;
  model: string;
  error: string | null;
  running: boolean;
}

/** Snips whose vector is missing or stale (text changed, or model changed). */
function pendingSnips(db: DatabaseSync, limit?: number): (EmbeddableSnip & { text_hash: string })[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.summary_md, s.quote_text, s.transcript_md,
              sh.title AS show_title, e.title AS episode_title,
              v.text_hash AS stored_hash, v.model AS stored_model
       FROM snips s
       JOIN episodes e ON e.id = s.episode_id
       JOIN shows sh ON sh.id = e.show_id
       LEFT JOIN snip_vectors v ON v.snip_id = s.id
       WHERE v.snip_id IS NULL OR v.model != ?`
    )
    .all(EMBED_MODEL) as unknown as (EmbeddableSnip & { stored_hash: string | null })[];
  const out = rows.map((r) => ({ ...r, text_hash: sha1(embeddingText(r)) }));
  return limit ? out.slice(0, limit) : out;
}

export function embedStatus(db: DatabaseSync): { embedded: number; total: number; pending: number; model: string } {
  const embedded = (
    db.prepare("SELECT COUNT(*) c FROM snip_vectors WHERE model = ?").get(EMBED_MODEL) as { c: number }
  ).c;
  const total = (db.prepare("SELECT COUNT(*) c FROM snips").get() as { c: number }).c;
  return { embedded, total, pending: Math.max(0, total - embedded), model: EMBED_MODEL };
}

/**
 * Embed everything that needs it, in batches, resumable: each batch commits, so
 * a stopped run picks up where it left off.
 */
export async function embedAll(
  db: DatabaseSync,
  embedder: Embedder,
  opts: {
    batchSize?: number;
    onProgress?: (done: number, total: number) => void;
    signal?: { aborted: boolean };
    /** Idle time between batches — the duty cycle that keeps the machine usable. */
    pauseMs?: number;
  } = {}
): Promise<{ embedded: number }> {
  const batchSize = opts.batchSize ?? 64;
  const pending = pendingSnips(db);
  const total = pending.length;
  let done = 0;
  const insert = db.prepare(
    `INSERT INTO snip_vectors (snip_id, model, dim, vec, text_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(snip_id) DO UPDATE SET model=excluded.model, dim=excluded.dim,
       vec=excluded.vec, text_hash=excluded.text_hash, updated_at=excluded.updated_at`
  );

  for (let i = 0; i < pending.length; i += batchSize) {
    if (opts.signal?.aborted) break;
    const batch = pending.slice(i, i + batchSize);
    const vectors = await embedder(batch.map(embeddingText));
    db.exec("BEGIN");
    try {
      for (let j = 0; j < batch.length; j++)
        insert.run(batch[j].id, EMBED_MODEL, vectors[j].length, toBlob(vectors[j]), batch[j].text_hash);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    done += batch.length;
    invalidateMatrix();
    opts.onProgress?.(done, total);
    if (opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs));
  }
  return { embedded: done };
}

/** In-memory copy of every vector: 32k × 384 floats ≈ 49 MB, loaded once. */
let matrix: { ids: string[]; data: Float32Array; dim: number } | null = null;

export function invalidateMatrix(): void {
  matrix = null;
}

function loadMatrix(db: DatabaseSync) {
  if (matrix) return matrix;
  const rows = db
    .prepare("SELECT snip_id, dim, vec FROM snip_vectors WHERE model = ? ORDER BY rowid")
    .all(EMBED_MODEL) as unknown as { snip_id: string; dim: number; vec: Uint8Array }[];
  const dim = rows[0]?.dim ?? EMBED_DIM;
  const data = new Float32Array(rows.length * dim);
  const ids: string[] = [];
  rows.forEach((r, i) => {
    ids.push(r.snip_id);
    data.set(fromBlob(r.vec), i * dim);
  });
  matrix = { ids, data, dim };
  return matrix;
}

/** Vectors are normalized at creation, so cosine similarity is a dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export interface Neighbor {
  id: string;
  score: number;
}

/** Top-k nearest snips to a vector; a brute-force scan is <10 ms at 32k. */
export function nearest(
  db: DatabaseSync,
  vec: Float32Array,
  k: number,
  exclude: Set<string> = new Set()
): Neighbor[] {
  const m = loadMatrix(db);
  const best: Neighbor[] = [];
  let worst = -Infinity;
  for (let i = 0; i < m.ids.length; i++) {
    if (exclude.has(m.ids[i])) continue;
    let sum = 0;
    const off = i * m.dim;
    for (let d = 0; d < m.dim; d++) sum += vec[d] * m.data[off + d];
    if (best.length < k || sum > worst) {
      best.push({ id: m.ids[i], score: sum });
      best.sort((a, b) => b.score - a.score);
      if (best.length > k) best.pop();
      worst = best[best.length - 1].score;
    }
  }
  return best;
}

export function getVector(db: DatabaseSync, snipId: string): Float32Array | null {
  const row = db
    .prepare("SELECT vec FROM snip_vectors WHERE snip_id = ? AND model = ?")
    .get(snipId, EMBED_MODEL) as { vec: Uint8Array } | undefined;
  return row ? fromBlob(row.vec) : null;
}
