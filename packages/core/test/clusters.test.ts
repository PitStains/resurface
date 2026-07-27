import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { importVault } from "../src/import.ts";
import { embedAll, invalidateMatrix, type Embedder } from "../src/embeddings.ts";
import {
  buildTopics,
  kmeans,
  labelClusters,
  listTopics,
  loadVectors,
  mapPoints,
  pca2,
  topicSnips,
  topicsStatus,
  type VectorSet,
} from "../src/clusters.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "vault", "Data");

/** Same deterministic stand-in the embedding tests use — no model download. */
const VOCAB = ["habit", "environment", "willpower", "grace", "morning", "snips", "upload", "sermon", "small", "start"];
const stubEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const lower = t.toLowerCase();
    const v = new Float32Array(VOCAB.length + 1);
    VOCAB.forEach((w, i) => (v[i] = (lower.match(new RegExp(w, "g")) ?? []).length));
    v[VOCAB.length] = 0.25;
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm) as Float32Array;
  });

/** Two tight, well-separated groups of unit vectors. */
function twoBlobs(perBlob = 20): VectorSet {
  const dim = 4;
  const ids: string[] = [];
  const data = new Float32Array(perBlob * 2 * dim);
  for (let i = 0; i < perBlob * 2; i++) {
    const blob = i < perBlob ? 0 : 1;
    const v = new Float32Array(dim);
    v[blob] = 1;
    v[2 + blob] = 0.05 * ((i % 5) - 2); // small jitter
    const norm = Math.hypot(...v);
    for (let d = 0; d < dim; d++) data[i * dim + d] = v[d] / norm;
    ids.push(`s${i}`);
  }
  return { ids, data, dim };
}

describe("kmeans", () => {
  it("separates two blobs and is deterministic", () => {
    const vs = twoBlobs();
    const a = kmeans(vs, 2, { seed: 1 });
    const b = kmeans(vs, 2, { seed: 1 });
    expect([...a.assignment]).toEqual([...b.assignment]);
    // Everything in the first blob shares a cluster, and the blobs differ.
    const first = a.assignment[0];
    expect([...a.assignment.slice(0, 20)].every((c) => c === first)).toBe(true);
    expect([...a.assignment.slice(20)].every((c) => c === a.assignment[20])).toBe(true);
    expect(a.assignment[0]).not.toBe(a.assignment[20]);
    expect(a.similarity[0]).toBeGreaterThan(0.9); // members sit close to their centroid
  });

  it("never asks for more clusters than there are snips", () => {
    const vs = twoBlobs(1);
    const r = kmeans(vs, 10, { seed: 3 });
    expect(r.k).toBe(2);
    expect(new Set([...r.assignment]).size).toBeLessThanOrEqual(2);
  });
});

describe("labelClusters", () => {
  it("names topics after terms that distinguish them, ignoring filler", () => {
    const docs = [
      "sleep and recovery the athlete",
      "sleep in the evening sleep",
      "habits and routines the daily",
      "daily habits routines",
    ];
    const labels = labelClusters(docs, Int32Array.from([0, 0, 1, 1]), 2);
    expect(labels[0].terms).toContain("sleep");
    expect(labels[1].terms.some((t) => ["habits", "routines", "daily"].includes(t))).toBe(true);
    // "the" is filler and never a label; "athlete" appears once, so c-TF-IDF
    // ranks it below the term that actually characterises the topic.
    expect(labels[0].terms).not.toContain("the");
    expect(labels[0].terms[0]).toBe("sleep");
    expect(labels[0].label[0]).toBe(labels[0].label[0].toUpperCase());
  });

  it("falls back to a numbered name when a topic has nothing distinctive", () => {
    expect(labelClusters(["the the the"], Int32Array.from([0]), 1)[0].label).toBe("Topic 1");
  });
});

describe("pca2", () => {
  it("spreads separated groups apart on the first axis, scaled to [-1, 1]", () => {
    const vs = twoBlobs();
    const { x, y } = pca2(vs);
    expect(Math.min(...x)).toBeGreaterThanOrEqual(-1.001);
    expect(Math.max(...x)).toBeLessThanOrEqual(1.001);
    const left = x.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
    const right = x.slice(20).reduce((a, b) => a + b, 0) / 20;
    expect(Math.abs(left - right)).toBeGreaterThan(1); // blobs land on opposite ends
    expect(y).toHaveLength(40);
  });
});

describe("buildTopics on the fixture vault", () => {
  let db: DatabaseSync;
  beforeEach(async () => {
    db = openDb(":memory:");
    importVault(db, FIXTURES);
    invalidateMatrix();
    await embedAll(db, stubEmbedder);
  });

  it("stores clusters, memberships and a layout point per snip", () => {
    const result = buildTopics(db, { k: 3 });
    expect(result.clusters).toBe(3);
    expect(result.snips).toBe(8);

    const status = topicsStatus(db);
    expect(status.clusters).toBe(3);
    expect(status.placed).toBe(8);

    const topics = listTopics(db);
    expect(topics).toHaveLength(3);
    expect(topics.reduce((n, t) => n + t.size, 0)).toBe(8);
    expect(topics[0].size).toBeGreaterThanOrEqual(topics[1].size); // biggest first
    expect(topics[0].label.length).toBeGreaterThan(0);

    const points = mapPoints(db);
    expect(points).toHaveLength(8);
    expect(points.every((p) => p.x >= -1.001 && p.x <= 1.001 && p.y >= -1.001 && p.y <= 1.001)).toBe(true);
    expect(points.every((p) => p.c >= 0)).toBe(true);
  });

  it("lists a topic's most central snips first", () => {
    buildTopics(db, { k: 2 });
    const topic = listTopics(db)[0];
    const { ids, total } = topicSnips(db, topic.id, { limit: 3 });
    expect(total).toBe(topic.size);
    expect(ids.length).toBeLessThanOrEqual(3);
  });

  it("replaces previous results instead of accumulating them", () => {
    buildTopics(db, { k: 3 });
    buildTopics(db, { k: 2 });
    expect(listTopics(db)).toHaveLength(2);
    expect(topicsStatus(db).placed).toBe(8);
  });

  it("does nothing when there are no vectors yet", () => {
    db.exec("DELETE FROM snip_vectors");
    expect(buildTopics(db)).toEqual({ clusters: 0, snips: 0 });
  });

  it("loads vectors back exactly as stored", () => {
    const vs = loadVectors(db);
    expect(vs.ids).toHaveLength(8);
    expect(vs.dim).toBe(VOCAB.length + 1);
    let norm = 0;
    for (let d = 0; d < vs.dim; d++) norm += vs.data[d] ** 2;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });
});

describe("labelClusters — keeping speakers out of labels", () => {
  // Two topics. Topic 0 spans two shows and is about sleep; the host's name
  // appears in every one of its snips, so raw c-TF-IDF would label it after the host.
  const docs = [
    "tarrow sleep waking", "tarrow sleep waking", "tarrow sleep melatonin",
    "tarrow sleep melatonin", "money wealth rich", "money wealth rich",
  ];
  const shows = ["s1", "s1", "s2", "s2", "s3", "s3"];
  const assignment = Int32Array.from([0, 0, 0, 0, 1, 1]);

  it("names the topic after the speaker when nothing corrects for it", () => {
    const labels = labelClusters(docs, assignment, 2);
    expect(labels[0].terms).toContain("tarrow");
  });

  it("drops a name the export states outright", () => {
    const labels = labelClusters(docs, assignment, 2, 3, { excludeTerms: new Set(["tarrow"]) });
    expect(labels[0].terms).not.toContain("tarrow");
    expect(labels[0].terms).toContain("sleep");
  });

  it("drops a term confined to fewer shows than its topic, with no name list", () => {
    // "melatonin" sits in one show; "sleep" spans both. Same frequency rank,
    // different spread — only the well-spread one should label the topic.
    const labels = labelClusters(docs, assignment, 2, 1, { shows });
    expect(labels[0].terms).not.toContain("melatonin");
  });

  it("leaves a single-show topic alone — there is nothing to compare against", () => {
    const labels = labelClusters(docs, assignment, 2, 3, { shows });
    expect(labels[1].terms.length).toBeGreaterThan(0);
  });

  it("excludes possessive forms of a name too", () => {
    const poss = ["tarrow's sleep waking", "tarrow's sleep waking", "tarrow's sleep melatonin",
      "tarrow's sleep melatonin", "money wealth rich", "money wealth rich"];
    const labels = labelClusters(poss, assignment, 2, 3, { excludeTerms: new Set(["tarrow"]) });
    expect(labels[0].terms).not.toContain("tarrow's");
  });
});