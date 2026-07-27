import { describe, expect, it, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { classifySnip, classifyAll, setSnipKind, kindStats, unsureSnips } from "../src/snipkind.ts";

/**
 * Fixtures are synthetic. What the classifier actually reads is the *shape* of
 * a note — bullet count, length, presence of section headers — so invented text
 * with the right shape tests it exactly as well as real notes would, without
 * putting anybody's library in the repository.
 *
 * The Snipd auto template: two bullets and a quote, no structure.
 */
const AUTO_NOTE = [
  "- Tidal patterns on the north coast shift measurably between spring and autumn each year.",
  "- The presenter links this to seabed temperature rather than to prevailing wind direction.",
].join("\n");

const SECTIONED_NOTE = [
  "**2. Main Theme**",
  "",
  "- Coastal measurement has to account for seasonal drift.",
  "",
  "**3. Insight Extraction**",
  "",
  "Method / Instrumentation",
  "- Fixed buoys drift less than towed sensors over a long survey.",
].join("\n");

describe("classifySnip", () => {
  it("recognises the auto template", () => {
    const v = classifySnip({ summary_md: AUTO_NOTE, quote_text: "Let your yes be yes." });
    expect(v.kind).toBe("auto");
    expect(v.confident).toBe(true);
  });

  it("calls a sectioned note manual", () => {
    const v = classifySnip({ summary_md: SECTIONED_NOTE, quote_text: "q" });
    expect(v.kind).toBe("manual");
    expect(v.confident).toBe(true);
  });

  it("does not depend on one user's section names", () => {
    // Someone else's note types entirely — still structure, still manual.
    const other = ["## Zusammenfassung", "- ein punkt", "## Fazit", "- noch einer"].join("\n");
    expect(classifySnip({ summary_md: other, quote_text: "q" }).kind).toBe("manual");
    const numbered = ["1. Wat Ik Leerde", "- iets", "2. Toepassing", "- iets anders"].join("\n");
    expect(classifySnip({ summary_md: numbered, quote_text: "q" }).kind).toBe("manual");
  });

  it("ignores duration entirely — a long clip with the auto note is still auto", () => {
    // The whole point: hand-made snips run from seconds to whole episodes.
    const v = classifySnip({ summary_md: AUTO_NOTE, quote_text: "q" });
    expect(v.kind).toBe("auto");
  });

  it("treats an unstructured but long note as manual", () => {
    const prose = "word ".repeat(400);
    const v = classifySnip({ summary_md: prose, quote_text: "q" });
    expect(v.kind).toBe("manual");
  });

  it("treats a snip clipped with no note as manual, but flags it as uncertain", () => {
    const v = classifySnip({ summary_md: "", quote_text: null });
    expect(v.kind).toBe("manual");
    expect(v.confident).toBe(false);
  });

  it("explains itself without naming any section", () => {
    const v = classifySnip({ summary_md: AUTO_NOTE, quote_text: "q" });
    expect(v.reason).toMatch(/auto template/);
    expect(v.reason).not.toMatch(/Main Theme|Core Frameworks/);
  });
});

describe("classifyAll", () => {
  let db: DatabaseSync;
  const insert = (id: string, summary: string | null, quote: string | null) =>
    db
      .prepare(
        `INSERT INTO snips (id, episode_id, ord, title, summary_md, quote_text) VALUES (?, 'e1', 1, ?, ?, ?)`
      )
      .run(id, id, summary, quote);

  beforeEach(() => {
    db = openDb(":memory:");
    db.exec(`INSERT INTO shows (id, title) VALUES ('s1','Show')`);
    db.exec(`INSERT INTO episodes (id, show_id, title) VALUES ('e1','s1','Ep')`);
  });

  it("counts both kinds", () => {
    insert("a", AUTO_NOTE, "q");
    insert("b", SECTIONED_NOTE, "q");
    const r = classifyAll(db);
    expect(r.auto).toBe(1);
    expect(r.manual).toBe(1);
    expect(kindStats(db)).toMatchObject({ auto: 1, manual: 1, overridden: 0 });
  });

  it("keeps a user's override through re-classification", () => {
    insert("a", AUTO_NOTE, "q");
    classifyAll(db);
    setSnipKind(db, "a", "manual");
    classifyAll(db); // a later import must not undo the correction
    const row = db.prepare(`SELECT kind, kind_source FROM snips WHERE id='a'`).get() as {
      kind: string;
      kind_source: string;
    };
    expect(row.kind).toBe("manual");
    expect(row.kind_source).toBe("user");
    expect(kindStats(db).overridden).toBe(1);
  });

  it("clearing an override returns the snip to the inferred kind", () => {
    insert("a", AUTO_NOTE, "q");
    classifyAll(db);
    setSnipKind(db, "a", "manual");
    setSnipKind(db, "a", null);
    const row = db.prepare(`SELECT kind, kind_source FROM snips WHERE id='a'`).get() as {
      kind: string;
      kind_source: string;
    };
    expect(row.kind).toBe("auto");
    expect(row.kind_source).toBe("inferred");
  });

  it("surfaces the uncertain ones for review, excluding decided ones", () => {
    insert("a", AUTO_NOTE, "q");
    insert("b", "x".repeat(800), "q"); // in the gap → uncertain
    classifyAll(db);
    expect((unsureSnips(db) as { id: string }[]).map((r) => r.id)).toEqual(["b"]);
    setSnipKind(db, "b", "manual");
    expect(unsureSnips(db)).toHaveLength(0);
  });
});
