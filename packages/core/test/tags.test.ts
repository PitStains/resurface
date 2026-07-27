import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { importVault } from "../src/import.ts";
import { getTag, listTags, normalizeTagKey, tagSnips, topTags } from "../src/tags.ts";
import { extractTagTerms, searchSnips, tagFacets } from "../src/search.ts";
import { tagToMarkdown } from "../src/exports.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "vault", "Data");
const HABITS = join("The Example Interview Show", "Building Better Habits.md");

let db: DatabaseSync;
let vaultDir: string;
beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), "resurface-tags-"));
  cpSync(FIXTURES, vaultDir, { recursive: true });
  db = openDb(":memory:");
  importVault(db, vaultDir);
});
afterEach(() => {
  db.close();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe("normalizeTagKey", () => {
  it("collapses case, whitespace and a leading hash into one identity", () => {
    expect(normalizeTagKey("To Revisit")).toBe("to revisit");
    expect(normalizeTagKey(" #to  Revisit ")).toBe("to revisit");
    expect(normalizeTagKey("chat")).toBe("chat");
    expect(normalizeTagKey("  ")).toBe("");
  });
});

describe("listTags", () => {
  it("merges spelling variants and counts snips, shows and favorites", () => {
    const tags = listTags(db);
    const byKey = new Map(tags.map((t) => [t.key, t]));
    // "grace" (devotional), "grace" (sectioned) and "Grace" (habits) are one tag.
    const grace = byKey.get("grace")!;
    expect(grace.snips).toBe(3);
    expect(grace.shows).toBe(2);
    expect(grace.favorites).toBe(1); // only the Snipd-favorited devotional snip
    expect(byKey.get("deep work")?.snips).toBe(1); // spaces survive wiki-link tags
    expect(byKey.get("chat")?.snips).toBe(1);
    expect(tags[0].key).toBe("grace"); // ordered by count
  });

  it("keeps the owner's own spelling as the display label", () => {
    expect(getTag(db, "GRACE")?.label).toMatch(/grace/i);
    expect(getTag(db, "deep work")?.label).toBe("deep work");
  });
});

describe("tagSnips", () => {
  it("lists a tag's snips newest first, with show and episode context", () => {
    const { snips, total } = tagSnips(db, "grace");
    expect(total).toBe(3);
    expect(snips[0].showTitle).toBeTruthy();
    expect(snips.some((s) => s.title === "Morning Reflection" && s.favorited)).toBe(true);
    expect(tagSnips(db, "grace", { order: "asc" }).snips[0].lastSnipDate).toBe("2026-03-12");
  });

  it("exports a tag as one markdown document", () => {
    const md = tagToMarkdown(db, "deep work");
    expect(md).toContain("# #deep work");
    expect(md).toContain("Start Small to Win Big");
    expect(md).toContain("#deep-work"); // spaces are hyphenated for Obsidian
  });
});

describe("search by tag", () => {
  it("parses tag: terms out of the query text", () => {
    expect(extractTagTerms('habits tag:chat')).toEqual({ text: "habits ", tags: ["chat"] });
    expect(extractTagTerms('tag:"to revisit" sleep').tags).toEqual(["to revisit"]);
    expect(extractTagTerms("no tags here").tags).toEqual([]);
  });

  it("filters by tag, alone and combined with text", () => {
    expect(searchSnips(db, "", { tags: ["grace"] }).total).toBe(3);
    expect(searchSnips(db, "tag:grace").total).toBe(3);
    expect(searchSnips(db, "habits tag:grace").total).toBe(1);
    expect(searchSnips(db, "", { tags: ["nonexistent"] }).total).toBe(0);
  });

  it("honors any/all across several tags", () => {
    expect(searchSnips(db, "", { tags: ["grace", "chat"], tagMode: "any" }).total).toBe(3);
    expect(searchSnips(db, "", { tags: ["grace", "chat"], tagMode: "all" }).total).toBe(1);
    expect(searchSnips(db, "", { tags: ["grace", "deep work"], tagMode: "all" }).total).toBe(1);
  });

  it("carries tags on every hit and counts facets for the result set", () => {
    const hit = searchSnips(db, "two-minute rule").hits[0];
    expect(hit.tags.sort()).toEqual(["Grace", "deep work"]);
    const facets = tagFacets(db, "", { tags: [], show: undefined, from: undefined });
    expect(facets).toEqual([]); // no query, no filters → nothing to facet
    const withQuery = tagFacets(db, "the ", {});
    expect(withQuery.find((f) => f.key === "grace")?.count).toBeGreaterThan(0);
  });

  it("does not let tag names leak into full-text matching", () => {
    // "deep work" is a tag on the habits snip, but its text never says it.
    expect(searchSnips(db, "deep work ").total).toBe(0);
  });
});

describe("tag sync with the vault", () => {
  it("drops a tag removed in Snipd but keeps tags on vault-missing snips", () => {
    const file = join(vaultDir, HABITS);
    const original = readFileSync(file, "utf8");

    // 1. Untagged in Snipd → gone here on the next sync.
    writeFileSync(file, original.replace(" [[Grace]] [[deep work]]", ""));
    importVault(db, vaultDir);
    expect(searchSnips(db, "", { tags: ["deep work"] }).total).toBe(0);
    expect(listTags(db).find((t) => t.key === "grace")?.snips).toBe(2);

    // 2. Whole snip vanishes from the vault → its tags stay, flagged retired.
    writeFileSync(file, original);
    importVault(db, vaultDir);
    writeFileSync(file, original.slice(0, original.indexOf("###  [Start Small")));
    importVault(db, vaultDir);
    const deepWork = getTag(db, "deep work")!;
    expect(deepWork.snips).toBe(1); // never deleted
    expect(deepWork.live).toBe(0); // but marked retired
    expect(listTags(db, { includeRetired: false }).some((t) => t.key === "deep work")).toBe(true);
    expect(tagSnips(db, "deep work").snips[0].missingFromVault).toBe(true);
  });

  it("counts tags within a period for the dashboard tile", () => {
    // Every tagged fixture episode lands on 2026-03-12.
    expect(topTags(db, { from: "2026-03-01", to: "2026-03-31" }).find((t) => t.key === "grace")?.count).toBe(3);
    expect(topTags(db, { from: "2026-04-01", to: "2026-04-30" })).toEqual([]);
    expect(topTags(db).find((t) => t.key === "grace")?.count).toBe(3);
  });
});
