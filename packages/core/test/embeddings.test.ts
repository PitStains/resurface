import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { importVault } from "../src/import.ts";
import {
  cosine,
  embedAll,
  embedStatus,
  embeddingText,
  getVector,
  invalidateMatrix,
  nearest,
  type Embedder,
} from "../src/embeddings.ts";
import { hybridSearch, relatedSnips, semanticSearch } from "../src/related.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "vault", "Data");

/**
 * Deterministic stand-in for the real model: a bag-of-words vector over a tiny
 * vocabulary, normalized. Same contract (unit vectors, cosine = dot product),
 * no 25 MB download in tests.
 */
const VOCAB = ["habit", "environment", "willpower", "grace", "morning", "snips", "upload", "sermon", "small", "start"];
const stubEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const lower = t.toLowerCase();
    const v = new Float32Array(VOCAB.length + 1);
    VOCAB.forEach((w, i) => (v[i] = (lower.match(new RegExp(w, "g")) ?? []).length));
    v[VOCAB.length] = 0.25; // keeps zero-word texts from being zero vectors
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm) as Float32Array;
  });

let db: DatabaseSync;
beforeEach(async () => {
  db = openDb(":memory:");
  importVault(db, FIXTURES);
  invalidateMatrix();
});

describe("embeddingText", () => {
  it("gives short snips their show and episode as context", () => {
    const text = embeddingText({
      id: "x",
      title: "Start Small to Win Big",
      summary_md: "- **Two-minute rule**\n- Start tiny",
      quote_text: "Every action you take is a vote",
      transcript_md: "a".repeat(2000),
      show_title: "The Example Interview Show",
      episode_title: "Building Better Habits",
    });
    expect(text).toContain("The Example Interview Show");
    expect(text).toContain("Building Better Habits");
    expect(text).toContain("Two-minute rule"); // markdown noise stripped, words kept
    expect(text).not.toContain("**");
    expect(text.length).toBeLessThanOrEqual(2000);
  });
});

describe("embedAll", () => {
  it("embeds every snip once and is resumable", async () => {
    expect(embedStatus(db).embedded).toBe(0);
    const first = await embedAll(db, stubEmbedder, { batchSize: 3 });
    expect(first.embedded).toBe(8);
    const status = embedStatus(db);
    expect(status.embedded).toBe(8);
    expect(status.pending).toBe(0);

    // Re-running is a no-op: nothing pending, nothing re-embedded.
    expect((await embedAll(db, stubEmbedder)).embedded).toBe(0);

    const vec = getVector(db, "01010101-0202-0303-0404-050505050505")!;
    expect(vec).toHaveLength(VOCAB.length + 1);
    expect(cosine(vec, vec)).toBeCloseTo(1, 5); // normalized
  });

  it("stops early when aborted, keeping what it finished", async () => {
    const signal = { aborted: false };
    let batches = 0;
    const slowStub: Embedder = async (texts) => {
      if (++batches === 2) signal.aborted = true;
      return stubEmbedder(texts);
    };
    await embedAll(db, slowStub, { batchSize: 2, signal });
    const status = embedStatus(db);
    expect(status.embedded).toBe(4);
    expect(status.pending).toBe(4);
    await embedAll(db, stubEmbedder); // resumes the rest
    expect(embedStatus(db).pending).toBe(0);
  });
});

describe("nearest / relatedSnips", () => {
  beforeEach(async () => {
    await embedAll(db, stubEmbedder);
  });

  it("ranks the closest vectors first", () => {
    const vec = getVector(db, "02020202-0303-0404-0505-060606060606")!; // "Environment Beats Willpower"
    const hits = nearest(db, vec, 3);
    expect(hits[0].id).toBe("02020202-0303-0404-0505-060606060606");
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
  });

  it("excludes snips from the same episode and carries full snip context", () => {
    const related = relatedSnips(db, "01010101-0202-0303-0404-050505050505", 5);
    const sameEpisode = related.some((r) => r.id === "02020202-0303-0404-0505-060606060606");
    expect(sameEpisode).toBe(false); // its episode sibling is filtered out
    expect(related.length).toBeGreaterThan(0);
    expect(related[0].showTitle).toBeTruthy();
    expect(related[0].episodeTitle).toBeTruthy();
    expect(related[0].score).toBeLessThanOrEqual(1);
  });

  it("returns nothing rather than guessing when a snip has no vector", () => {
    db.exec("DELETE FROM snip_vectors");
    invalidateMatrix();
    expect(relatedSnips(db, "01010101-0202-0303-0404-050505050505")).toEqual([]);
  });
});

describe("semantic & hybrid search", () => {
  beforeEach(async () => {
    await embedAll(db, stubEmbedder);
  });

  it("finds snips by meaning without a shared keyword", async () => {
    // "willpower" never appears in the habits snip's title; the vector does.
    const r = await semanticSearch(db, "environment willpower", stubEmbedder, {}, 3);
    expect(r.hits[0].title).toBe("Environment Beats Willpower");
  });

  it("honors filters on semantic hits", async () => {
    const showId = (
      db.prepare("SELECT show_id FROM episodes WHERE title = 'Building Better Habits'").get() as {
        show_id: string;
      }
    ).show_id;
    const r = await semanticSearch(db, "grace morning", stubEmbedder, { show: showId }, 5);
    expect(r.hits.every((h) => h.showId === showId)).toBe(true);
  });

  it("fuses keyword and semantic ranks, keeping exact matches on top", async () => {
    const r = await hybridSearch(db, "two-minute rule", stubEmbedder, { limit: 5 });
    expect(r.hits[0].title).toBe("Start Small to Win Big"); // the literal match wins
    expect(r.keywordTotal).toBe(1);
    expect(r.total).toBeGreaterThan(1); // but meaning-neighbors ride along
  });

  it("still answers when the words match nothing at all", async () => {
    const keywordOnly = await hybridSearch(db, "willpower", stubEmbedder, { limit: 5 });
    expect(keywordOnly.total).toBeGreaterThan(0);
    const r = await hybridSearch(db, "environment", stubEmbedder, { limit: 5 });
    expect(r.hits.some((h) => h.title === "Environment Beats Willpower")).toBe(true);
  });
});
