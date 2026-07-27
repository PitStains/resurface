import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { countWords, planPack, writePack, WORDS_PER_SOURCE } from "../src/notebooklm.ts";

let dir: string;
let db: DatabaseSync;

/** Invented shows and text: nothing here comes from a real vault. */
function seed(opts: { shows?: number; snipsPerShow?: number; words?: number } = {}) {
  const shows = opts.shows ?? 2;
  const per = opts.snipsPerShow ?? 3;
  const words = opts.words ?? 20;
  const filler = Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
  for (let s = 0; s < shows; s++) {
    db.prepare(`INSERT INTO shows (id, title) VALUES (?, ?)`).run(`sh${s}`, `Show ${s}`);
    db.prepare(
      `INSERT INTO episodes (id, show_id, title, last_snip_date) VALUES (?, ?, ?, ?)`
    ).run(`e${s}`, `sh${s}`, `Episode ${s}`, `2026-0${(s % 9) + 1}-01`);
    for (let i = 0; i < per; i++) {
      db.prepare(
        `INSERT INTO snips (id, episode_id, ord, title, summary_md, quote_text, transcript_md, kind, favorited)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `s${s}-${i}`,
        `e${s}`,
        i,
        `Snip ${s}-${i}`,
        filler,
        "A sentence someone said out loud.",
        `${filler} ${filler}`,
        i === 0 ? "manual" : "auto",
        i === 0 ? 1 : 0
      );
    }
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "resurface-nblm-"));
  db = openDb(join(dir, "resurface.db"));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("countWords", () => {
  it("counts words, not characters, and survives empty input", () => {
    expect(countWords("one two three")).toBe(3);
    expect(countWords("  padded \n out  ")).toBe(2);
    expect(countWords("")).toBe(0);
    expect(countWords(null)).toBe(0);
  });
});

describe("planPack", () => {
  it("makes one file per show by default", () => {
    seed({ shows: 3 });
    const plan = planPack(db);
    expect(plan.files).toHaveLength(3);
    expect(plan.files.map((f) => f.group)).toEqual(["Show 0", "Show 1", "Show 2"]);
    expect(plan.totalSnips).toBe(9);
  });

  it("never mixes two shows into one file, however small they are", () => {
    // Grouping is what makes a NotebookLM citation mean something; packing two
    // shows together to save a file would defeat the point of the export.
    seed({ shows: 4, snipsPerShow: 1, words: 5 });
    expect(planPack(db).files).toHaveLength(4);
  });

  it("splits a show that outgrows one file, and says which part is which", () => {
    seed({ shows: 1, snipsPerShow: 6, words: 2_000 });
    const plan = planPack(db, { maxWords: 10_000 });
    expect(plan.files.length).toBeGreaterThan(1);
    expect(plan.files.every((f) => f.words <= 10_000)).toBe(true);
    expect(plan.files[0].name).toMatch(/part-1-of-\d/);
    expect(plan.files.at(-1)!.parts).toBe(plan.files.length);
  });

  it("counts the guide as a source when judging what a plan allows", () => {
    seed({ shows: 49, snipsPerShow: 1, words: 5 });
    const plan = planPack(db);
    // 49 files + the "about this collection" source is 50 exactly.
    expect(plan.files).toHaveLength(49);
    expect(plan.fits.free).toBe(true);
  });

  it("says plainly when an export is too big for the free plan", () => {
    seed({ shows: 60, snipsPerShow: 1, words: 5 });
    const plan = planPack(db);
    expect(plan.fits.free).toBe(false);
    expect(plan.fits.pro).toBe(true);
    expect(plan.notes.join(" ")).toMatch(/free plan/);
  });

  it("keeps every file under NotebookLM's own ceiling", () => {
    seed({ shows: 1, snipsPerShow: 4, words: 200 });
    const plan = planPack(db, { maxWords: 999_999 });
    expect(plan.options.maxWords).toBeLessThanOrEqual(WORDS_PER_SOURCE);
  });

  it("transcripts make it much bigger, which is the point of the choice", () => {
    seed({ shows: 1, snipsPerShow: 3, words: 50 });
    const notes = planPack(db, { include: "notes" }).totalWords;
    const full = planPack(db, { include: "full" }).totalWords;
    expect(full).toBeGreaterThan(notes * 2);
  });

  it("narrows to what was starred, or to what was made by hand", () => {
    seed({ shows: 2, snipsPerShow: 3 });
    expect(planPack(db, { scope: "starred" }).totalSnips).toBe(2);
    expect(planPack(db, { scope: "manual" }).totalSnips).toBe(2);
    expect(planPack(db, { scope: "auto" }).totalSnips).toBe(4);
  });

  it("groups by date when asked, naming files after the range they cover", () => {
    seed({ shows: 2, snipsPerShow: 2 });
    const plan = planPack(db, { group: "flat" });
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].name).toMatch(/snips-2026-\d\d-\d\d-to-2026-\d\d-\d\d/);
  });
});

describe("writePack", () => {
  it("writes the sources, the guide, and instructions that are not a source", () => {
    seed({ shows: 2 });
    const out = writePack(db, join(dir, "exports"));
    const sources = readdirSync(out.sourcesDir);
    expect(sources).toHaveLength(3); // two shows + the guide
    expect(sources).toContain("00-about-this-collection.md");
    // The instructions must sit outside the folder that gets uploaded, or they
    // become a source of their own and pollute every answer.
    expect(existsSync(join(out.dir, "HOW-TO-IMPORT.md"))).toBe(true);
    expect(sources).not.toContain("HOW-TO-IMPORT.md");
  });

  it("puts the snip's note and quote in the file, under a heading", () => {
    seed({ shows: 1, snipsPerShow: 1 });
    const out = writePack(db, join(dir, "exports"));
    const text = readFileSync(join(out.sourcesDir, out.files[0].name), "utf8");
    expect(text).toContain("# Show 0");
    expect(text).toContain("## Snip 0-0");
    expect(text).toContain("*Show 0 — Episode 0");
    expect(text).toContain("> A sentence someone said out loud.");
  });

  it("leaves transcripts out unless they were asked for", () => {
    seed({ shows: 1, snipsPerShow: 1 });
    const off = writePack(db, join(dir, "a"));
    expect(readFileSync(join(off.sourcesDir, off.files[0].name), "utf8")).not.toContain("### Transcript");
    const on = writePack(db, join(dir, "b"), { include: "full" });
    expect(readFileSync(join(on.sourcesDir, on.files[0].name), "utf8")).toContain("### Transcript");
  });

  it("tells the reader that quotes are transcribed speech", () => {
    // Without this the model attributes spoken words to the listener.
    seed({ shows: 1 });
    const out = writePack(db, join(dir, "exports"));
    const about = readFileSync(join(out.sourcesDir, "00-about-this-collection.md"), "utf8");
    expect(about).toMatch(/transcribed from audio/);
    expect(about).toMatch(/not.*when the episode was published/i);
  });

  it("refuses to write a pack with nothing in it", () => {
    // An empty library, or a filter that matches nothing. A folder holding only
    // instructions looks like success until it reaches NotebookLM.
    expect(() => writePack(db, join(dir, "exports"))).toThrow(/Nothing to export/);
    seed({ shows: 1 });
    db.exec(`UPDATE snips SET favorited = 0`);
    expect(() => writePack(db, join(dir, "exports"), { scope: "starred" })).toThrow(/Nothing to export/);
  });

  it("says so in the plan before the button is ever pressed", () => {
    expect(planPack(db).notes.join(" ")).toMatch(/nothing to export/i);
  });

  it("does not overwrite an earlier export", () => {
    seed({ shows: 1 });
    const first = writePack(db, join(dir, "exports"));
    const second = writePack(db, join(dir, "exports"), { include: "full" });
    expect(second.dir).not.toBe(first.dir);
    expect(existsSync(first.dir)).toBe(true);
  });
});
