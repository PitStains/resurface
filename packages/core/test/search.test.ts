import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { importVault } from "../src/import.ts";
import { buildMatchQuery, createSavedSearch, listSavedSearches, searchSnips } from "../src/search.ts";
import {
  bookmarksTimeline,
  listBookmarks,
  setBookmark,
  snipdFavoritesTimeline,
} from "../src/favorites.ts";
import { listBooks, listPeople } from "../src/mentions.ts";
import { favoritesToMarkdown, snipToMarkdown } from "../src/exports.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "vault", "Data");

let db: DatabaseSync;
let vaultDir: string;
beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), "resurface-search-"));
  cpSync(FIXTURES, vaultDir, { recursive: true });
  db = openDb(":memory:");
  importVault(db, vaultDir);
});
afterEach(() => {
  db.close();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe("buildMatchQuery", () => {
  it("quotes tokens, strips FTS specials, prefix-matches the last token", () => {
    expect(buildMatchQuery("identity habits")).toBe('"identity" "habits" *');
    expect(buildMatchQuery("identity habits ")).toBe('"identity" "habits"');
    expect(buildMatchQuery('att*ck "quoted"')).toBe('"attck" "quoted" *');
    expect(buildMatchQuery("   ")).toBeNull();
  });
});

describe("searchSnips", () => {
  it("finds snips by transcript text with a highlighted snippet", () => {
    const r = searchSnips(db, "two-minute rule");
    expect(r.total).toBe(1);
    expect(r.hits[0].title).toBe("Start Small to Win Big");
    expect(r.hits[0].transcriptSnippet).toContain("<mark>");
    expect(r.hits[0].showTitle).toBe("The Example Interview Show");
  });

  it("finds prose inside sectioned AI notes (the missing-content bug)", () => {
    const r = searchSnips(db, "eternal counsel");
    expect(r.total).toBe(1);
    expect(r.hits[0].summaryMd).toContain("**2. Main Theme**");
  });

  it("weights title matches above transcript matches", () => {
    const r = searchSnips(db, "environment");
    expect(r.hits[0].title).toBe("Environment Beats Willpower");
  });

  it("carries the Snipd ⭐ favorited flag and honors starredOnly with zero bookmarks", () => {
    const r = searchSnips(db, "gratitude ");
    expect(r.total).toBe(1);
    expect(r.hits[0].favorited).toBe(true);
    expect(searchSnips(db, "gratitude ", { starredOnly: true }).total).toBe(1);
    expect(searchSnips(db, "willpower ", { starredOnly: true }).total).toBe(0);
  });

  it("boosts bookmarked items in relevance order", () => {
    // Both the uploads snip and the mojibake snip mention "snips" in their summaries.
    const before = searchSnips(db, "snips ");
    expect(before.total).toBe(2);
    const second = before.hits[1];
    setBookmark(db, "snip", second.id, true);
    setBookmark(db, "episode", second.episodeId, true); // combined ×1.875 boost
    const after = searchSnips(db, "snips ");
    expect(after.hits[0].id).toBe(second.id);
    expect(after.hits[0].bookmarkSnip).toBe(true);
    expect(after.hits[0].bookmarkEpisode).toBe(true);
  });

  it("applies filters: show, hasQuote, dates", () => {
    const showId = (
      db.prepare("SELECT show_id FROM episodes WHERE title = 'Building Better Habits'").get() as {
        show_id: string;
      }
    ).show_id;
    const show = searchSnips(db, "the ", { show: showId });
    expect(show.hits.every((h) => h.showTitle === "The Example Interview Show")).toBe(true);

    const quoted = searchSnips(db, "the ", { hasQuote: true });
    expect(quoted.hits.every((h) => h.quoteText !== null)).toBe(true);

    expect(searchSnips(db, "snips ", { from: "2026-06-01", to: "2026-06-30" }).total).toBe(1);
  });

  it("keeps vault-missing snips searchable forever, flagged (never-delete)", () => {
    expect(searchSnips(db, "willpower ").total).toBe(1);
    const file = join(vaultDir, "The Example Interview Show", "Building Better Habits.md");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.slice(0, original.indexOf("###  [Environment Beats Willpower]")));
    importVault(db, vaultDir);
    const r = searchSnips(db, "willpower ");
    expect(r.total).toBe(1); // still here
    expect(r.hits[0].missingFromVault).toBe(true);
    writeFileSync(file, original);
    importVault(db, vaultDir);
    expect(searchSnips(db, "willpower ").hits[0].missingFromVault).toBe(false);
  });
});

describe("favorites (Snipd) & bookmarks (in-app)", () => {
  it("lists Snipd favorites chronologically, read-only from the export", () => {
    const favs = snipdFavoritesTimeline(db);
    expect(favs).toHaveLength(1);
    expect(favs[0].kind).toBe("favorite");
    expect(favs[0].title).toBe("Morning Reflection");
    expect(favs[0].date).toBe("2026-03-12");
  });

  it("carries show and episode titles separately so rows can lead with the podcast", () => {
    const [fav] = snipdFavoritesTimeline(db);
    expect(fav.showTitle).toBe("Daily Example Devotional");
    expect(fav.episodeTitle).toBe("March 12 | Morning");
    // The combined subtitle stays for exports, but the UI never has to split it.
    expect(fav.subtitle).toBe("Daily Example Devotional — March 12 | Morning");
    expect(fav.tags).toEqual(["grace"]);
  });

  it("bookmarks all three levels and orders the timeline chronologically", () => {
    const snipId = "01010101-0202-0303-0404-050505050505"; // interview, 2026-03-12, 03:12
    setBookmark(db, "snip", snipId, true);
    setBookmark(db, "episode", "21212121-3232-4343-5454-656565656565", true); // devotional 2026-03-12
    setBookmark(db, "show", "eeeeeeee-ffff-0000-1111-222222222222", true); // Sermon Show

    const marks = listBookmarks(db);
    expect(marks.snip).toEqual([snipId]);
    expect(marks.episode).toHaveLength(1);

    const asc = bookmarksTimeline(db, { order: "asc" });
    expect(asc).toHaveLength(3);
    expect(asc[0].date).toBe("2026-03-12");
    expect(asc[0].type).toBe("episode"); // no startSec sorts before the 03:12 snip
    expect(asc[1].type).toBe("snip");
    expect(asc[2].type).toBe("show"); // bookmarked today

    setBookmark(db, "snip", snipId, false);
    expect(bookmarksTimeline(db)).toHaveLength(2);
  });

  it("exports both favorites and bookmarks as markdown", () => {
    setBookmark(db, "snip", "01010101-0202-0303-0404-050505050505", true);
    const md = favoritesToMarkdown(db);
    expect(md).toContain("# Starred");
    expect(md).toContain("## ⭐ Snipd favorites");
    expect(md).toContain("Morning Reflection");
    expect(md).toContain("## 🔖 Bookmarks");
    expect(md).toContain("Start Small to Win Big");
  });
});

describe("mentions", () => {
  it("lists books and people with counts", () => {
    const books = listBooks(db) as { title: string; mentions: number; author: string | null }[];
    expect(books.some((b) => b.title === "Atomic Example" && b.author === "John Writer" && b.mentions === 1)).toBe(true);
    const people = listPeople(db) as { name: string; episodes: number }[];
    expect(people.some((p) => p.name === "Jane Doe" && p.episodes === 1)).toBe(true);
  });
});

describe("saved searches", () => {
  it("creates and reports new matches since last seen", () => {
    const id = createSavedSearch(db, "habit stuff", "habits", {});
    const list = listSavedSearches(db);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    expect(list[0].newCount).toBe(0); // nothing newer than "now"
  });
});

describe("snipToMarkdown", () => {
  it("renders a copyable markdown block", () => {
    const hit = searchSnips(db, "two-minute rule").hits[0];
    const md = snipToMarkdown(hit);
    expect(md).toContain("### Start Small to Win Big (03:12–05:18)");
    expect(md).toContain("> Every action you take");
    expect(md).toContain("[Play in Snipd](https://share.snipd.com/snip/01010101-0202-0303-0404-050505050505)");
  });
});

describe("filtering by who made the snip", () => {
  it("splits the library into auto and hand-made without losing any", () => {
    // Every snip is one or the other, so the two filters must partition the
    // library exactly — no snip counted twice, none dropped.
    const all = (db.prepare("SELECT COUNT(*) c FROM snips").get() as { c: number }).c;
    const auto = searchSnips(db, "", { kind: "auto", limit: 100 }).total;
    const manual = searchSnips(db, "", { kind: "manual", limit: 100 }).total;
    expect(auto + manual).toBe(all);
    expect(auto).toBeGreaterThan(0);
    expect(manual).toBeGreaterThan(0);
  });

  it("returns only snips of the requested kind", () => {
    for (const kind of ["auto", "manual"] as const) {
      const hits = searchSnips(db, "", { kind, limit: 100 }).hits;
      const ids = hits.map((h) => h.id);
      const rows = db
        .prepare(`SELECT kind FROM snips WHERE id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as unknown as { kind: string }[];
      expect(rows.every((r) => r.kind === kind)).toBe(true);
    }
  });

  it("works as a filter on its own, with no search text", () => {
    // "Browse the ones you made" has no query behind it.
    expect(searchSnips(db, "", { kind: "manual", limit: 5 }).hits.length).toBeGreaterThan(0);
  });

  it("combines with a text query rather than replacing it", () => {
    const text = searchSnips(db, "habit", { limit: 100 }).total;
    const narrowed = searchSnips(db, "habit", { kind: "manual", limit: 100 }).total;
    expect(narrowed).toBeLessThanOrEqual(text);
  });

  it("does not change ranking, only membership", () => {
    // Organising is not endorsing: the same rule tags follow.
    const unfiltered = searchSnips(db, "habit", { limit: 100 }).hits.map((h) => h.id);
    const filtered = searchSnips(db, "habit", { kind: "auto", limit: 100 }).hits.map((h) => h.id);
    expect(filtered).toEqual(unfiltered.filter((id) => filtered.includes(id)));
  });
});