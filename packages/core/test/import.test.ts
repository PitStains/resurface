import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importVault } from "../src/import.ts";
import { openDb } from "../src/db.ts";
import type { DatabaseSync } from "node:sqlite";

const FIXTURES = join(import.meta.dirname, "fixtures", "vault", "Data");

let vaultDir: string;
let db: DatabaseSync;

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), "resurface-test-"));
  cpSync(FIXTURES, vaultDir, { recursive: true });
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
  rmSync(vaultDir, { recursive: true, force: true });
});

// Never-delete policy: rows are only ever flagged (archived=1 = "missing from
// vault"), so totals are stable and flags tell the story.
function counts() {
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    shows: one("SELECT COUNT(*) c FROM shows"),
    episodes: one("SELECT COUNT(*) c FROM episodes"),
    snips: one("SELECT COUNT(*) c FROM snips"),
    flaggedSnips: one("SELECT COUNT(*) c FROM snips WHERE archived = 1"),
    flaggedEpisodes: one("SELECT COUNT(*) c FROM episodes WHERE archived = 1"),
  };
}

describe("importVault", () => {
  it("imports the whole fixture vault, rescuing broken-YAML files via the lenient parser", () => {
    const report = importVault(db, vaultDir);
    expect(report.filesSeen).toBe(8);
    expect(report.filesParsed).toBe(8);
    expect(report.filesSkipped).toBe(0);
    expect(report.snipsNew).toBe(8);
    expect(report.warnings.some((w) => w.message.includes("used lenient parser"))).toBe(true);
    expect(counts()).toMatchObject({ shows: 7, episodes: 8, snips: 8 });
  });

  it("imports Snipd ⭐ favorites and tags into snip rows", () => {
    importVault(db, vaultDir);
    const fav = db
      .prepare("SELECT favorited, tags_json FROM snips WHERE id = '31313131-4242-5353-6464-757575757575'")
      .get() as { favorited: number; tags_json: string | null };
    expect(fav.favorited).toBe(1);
    expect(JSON.parse(fav.tags_json!)).toEqual(["grace"]);
    const total = db.prepare("SELECT COUNT(*) c FROM snips WHERE favorited = 1").get() as { c: number };
    expect(total.c).toBe(1);
  });

  it("is idempotent: second run changes nothing and touches nothing", () => {
    importVault(db, vaultDir);
    const before = counts();
    const second = importVault(db, vaultDir);
    expect(second.filesUnchanged).toBe(8);
    expect(second.filesParsed).toBe(0);
    expect(second.snipsNew).toBe(0);
    expect(second.snipsUpdated).toBe(0);
    expect(counts()).toEqual(before);
  });

  it("re-parses everything when the parser version changes or --full is forced", () => {
    importVault(db, vaultDir);
    // A missing version row (pre-versioning DB) must also force a re-parse.
    db.prepare("DELETE FROM settings WHERE key = 'parser_version'").run();
    const missing = importVault(db, vaultDir);
    expect(missing.filesUnchanged).toBe(0);
    expect(missing.filesParsed).toBe(8);
    db.prepare("UPDATE settings SET value_json = '1' WHERE key = 'parser_version'").run();
    const bumped = importVault(db, vaultDir);
    expect(bumped.filesUnchanged).toBe(0);
    expect(bumped.filesParsed).toBe(8);
    expect(bumped.snipsNew).toBe(0); // still idempotent — snips update in place
    const forced = importVault(db, vaultDir, { force: true });
    expect(forced.filesParsed).toBe(8);
  });

  it("flags snips removed from a rewritten file as missing (never deletes) and un-flags on restore", () => {
    importVault(db, vaultDir);
    const file = join(vaultDir, "The Example Interview Show", "Building Better Habits.md");
    const original = readFileSync(file, "utf8");
    // Remove the second snip (simulates deletion in the Snipd app + full-file resync).
    const truncated = original.slice(0, original.indexOf("###  [Environment Beats Willpower]"));
    writeFileSync(file, truncated);

    const report = importVault(db, vaultDir);
    expect(report.snipsArchived).toBe(1);
    expect(counts().flaggedSnips).toBe(1);
    expect(counts().snips).toBe(8); // still in the database

    // Restore the file → flag clears, same id.
    writeFileSync(file, original);
    importVault(db, vaultDir);
    expect(counts().flaggedSnips).toBe(0);
    const revived = db
      .prepare("SELECT archived FROM snips WHERE id = ?")
      .get("02020202-0303-0404-0505-060606060606") as { archived: number };
    expect(revived.archived).toBe(0);
  });

  it("flags (never deletes) episodes whose files disappear", () => {
    importVault(db, vaultDir);
    rmSync(join(vaultDir, "Daily Example Devotional"), { recursive: true });
    const report = importVault(db, vaultDir);
    expect(report.episodesArchived).toBe(1);
    expect(counts().flaggedEpisodes).toBe(1);
    expect(counts().episodes).toBe(8); // still in the database
  });

  it("tolerates user edits appended between snips (append-mode)", () => {
    importVault(db, vaultDir);
    const file = join(vaultDir, "Daily Example Devotional", "March 12 _ Morning.md");
    const edited = readFileSync(file, "utf8") + "\n\nMy own note typed in Obsidian.\n";
    writeFileSync(file, edited);
    const report = importVault(db, vaultDir);
    expect(report.filesParsed).toBe(1);
    expect(report.snipsArchived).toBe(0);
    expect(counts().snips).toBe(8);
  });

  it("falls back to the furthest snip end when episode duration is 0 (seen in real feeds)", () => {
    writeFileSync(
      join(vaultDir, "The Example Interview Show", "Zero Duration.md"),
      [
        "---",
        "episode_title: Zero Duration",
        "show_title: The Example Interview Show",
        "episode_publish_date: 2026-07-08",
        "last_snip_date: 2026-07-08",
        "episode_duration_minutes: 0",
        'episode_url: "https://share.snipd.com/episode/e1e1e1e1-f2f2-0303-1414-252525252525"',
        'show_url: "https://share.snipd.com/show/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"',
        "snips_count: 1",
        "from_snipd: true",
        "---",
        "# Zero Duration",
        "",
        "## Snips",
        "",
        "###  [Long Snip](https://share.snipd.com/snip/f1f1f1f1-0202-1313-2424-353535353535) ",
        "",
        "🎧 00:00 - 44:03 (44:02)",
        "",
        "- A snip whose end time is the only duration signal.",
        "",
        "---",
      ].join("\n")
    );
    importVault(db, vaultDir);
    const row = db
      .prepare("SELECT duration_sec FROM episodes WHERE title = 'Zero Duration'")
      .get() as { duration_sec: number };
    expect(row.duration_sec).toBe(44 * 60 + 3);
  });
});
