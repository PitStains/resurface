import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { importVault } from "../src/import.ts";
import { embedAll, invalidateMatrix, type Embedder } from "../src/embeddings.ts";
import { buildTopics } from "../src/clusters.ts";
import {
  assignCategories,
  categoriesStatus,
  categorySnips,
  createCategory,
  deleteCategory,
  listCategories,
  mergeCategories,
  renameCategory,
  seedCategoriesFromTopics,
  setCategorySnip,
  snipCategories,
} from "../src/categories.ts";
import { ask } from "../src/ask.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "vault", "Data");
const HABITS_SNIP = "01010101-0202-0303-0404-050505050505"; // "Start Small to Win Big"
const WILLPOWER_SNIP = "02020202-0303-0404-0505-060606060606"; // "Environment Beats Willpower"

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

let db: DatabaseSync;
beforeEach(async () => {
  db = openDb(":memory:");
  importVault(db, FIXTURES);
  invalidateMatrix();
  await embedAll(db, stubEmbedder);
});

describe("seeding and assignment", () => {
  it("seeds one category per topic and assigns snips by similarity", () => {
    buildTopics(db, { k: 3 });
    expect(seedCategoriesFromTopics(db).created).toBe(3);

    const before = listCategories(db);
    expect(before).toHaveLength(3);

    const result = assignCategories(db, { threshold: 0.3 });
    expect(result.categories).toBe(3);
    expect(result.assignments).toBeGreaterThan(0);

    const status = categoriesStatus(db);
    expect(status.categories).toBe(3);
    expect(status.assigned + status.uncategorized).toBe(8);
  });

  it("is multi-label: a low cutoff puts a snip in more categories than a high one", () => {
    buildTopics(db, { k: 3 });
    seedCategoriesFromTopics(db);
    assignCategories(db, { threshold: 0.9 });
    const strict = snipCategories(db, HABITS_SNIP).length;
    assignCategories(db, { threshold: 0.05 });
    const loose = snipCategories(db, HABITS_SNIP).length;
    expect(loose).toBeGreaterThan(strict);
  });

  it("seeding twice doesn't duplicate categories", () => {
    buildTopics(db, { k: 2 });
    seedCategoriesFromTopics(db);
    expect(seedCategoriesFromTopics(db).created).toBe(0);
    expect(listCategories(db)).toHaveLength(2);
  });

  it("does nothing without vectors rather than guessing", () => {
    db.exec("DELETE FROM snip_vectors");
    createCategory(db, "Empty");
    expect(assignCategories(db)).toEqual({ categories: 0, assignments: 0, skipped: 0 });
  });
});

describe("user corrections", () => {
  it("keeps pinned snips through a re-assignment, and removals stay removed", () => {
    const id = createCategory(db, "Habits");
    setCategorySnip(db, id, HABITS_SNIP, true);
    expect(categorySnips(db, id).total).toBe(1);

    // A pinned snip defines the category, so re-assigning keeps it and pulls in
    // its neighbours rather than wiping the slate.
    assignCategories(db, { threshold: 0.3 });
    const ids = categorySnips(db, id).ids;
    expect(ids).toContain(HABITS_SNIP);

    setCategorySnip(db, id, HABITS_SNIP, false);
    expect(categorySnips(db, id).ids).not.toContain(HABITS_SNIP);
  });

  it("renames, merges and deletes", () => {
    const a = createCategory(db, "Habits");
    const b = createCategory(db, "Routines");
    setCategorySnip(db, a, HABITS_SNIP, true);
    setCategorySnip(db, b, WILLPOWER_SNIP, true);

    renameCategory(db, a, "Habit formation");
    expect(listCategories(db).find((c) => c.id === a)?.name).toBe("Habit formation");

    mergeCategories(db, b, a);
    expect(listCategories(db).some((c) => c.id === b)).toBe(false);
    const merged = categorySnips(db, a).ids;
    expect(merged).toContain(HABITS_SNIP);
    expect(merged).toContain(WILLPOWER_SNIP);

    deleteCategory(db, a);
    expect(listCategories(db)).toHaveLength(0);
    // Deleting a category never touches the snips themselves.
    expect((db.prepare("SELECT COUNT(*) c FROM snips").get() as { c: number }).c).toBe(8);
  });
});

describe("ask", () => {
  it("answers from snips with a numbered citation per source", async () => {
    const a = await ask(db, "two-minute rule", stubEmbedder, { k: 3 });
    expect(a.mode).toBe("extractive");
    expect(a.sources.length).toBeGreaterThan(0);
    expect(a.sources[0].n).toBe(1);
    expect(a.sources[0].passage.length).toBeGreaterThan(0);
    expect(a.answer).toContain("[1]");
    // Extractive means quoted, not generated: the text comes from the sources.
    expect(a.answer).toContain(a.sources[0].passage);
  });

  it("says so plainly when nothing matches", async () => {
    db.exec("DELETE FROM snip_vectors");
    invalidateMatrix();
    const a = await ask(db, "quantum chromodynamics", stubEmbedder);
    expect(a.sources).toHaveLength(0);
    expect(a.answer).toMatch(/Nothing in your library/);
  });

  it("falls back to quoted passages when the local model is unreachable", async () => {
    const a = await ask(db, "habits", stubEmbedder, {
      llm: { provider: "ollama", url: "http://127.0.0.1:9", model: "nope" },
      k: 2,
    });
    expect(a.mode).toBe("extractive");
    expect(a.llmError).toBeTruthy();
    expect(a.sources.length).toBeGreaterThan(0);
  });
});
