import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { agoLabel, digestRss, onThisDay, serendipity, weeklyDigest } from "../src/digest.ts";
import { recordReview } from "../src/review.ts";

const TODAY = "2026-07-21";
let db: DatabaseSync;

function addEpisode(id: string, date: string, showId = "s1") {
  db.prepare(`INSERT OR IGNORE INTO shows (id, title) VALUES (?, ?)`).run(showId, `Show ${showId}`);
  db.prepare(`INSERT INTO episodes (id, show_id, title, last_snip_date) VALUES (?, ?, ?, ?)`).run(
    id,
    showId,
    `Episode ${id}`,
    date
  );
}
function addSnip(id: string, episodeId: string, opts: { favorited?: number; kind?: string } = {}) {
  db.prepare(
    `INSERT INTO snips (id, episode_id, ord, title, quote_text, summary_md, favorited, kind)
     VALUES (?, ?, 1, ?, ?, 'summary', ?, ?)`
  ).run(
    id,
    episodeId,
    `Title ${id}`,
    "A quote comfortably longer than the forty character minimum for substance.",
    opts.favorited ?? 0,
    opts.kind ?? "auto"
  );
}

beforeEach(() => {
  db = openDb(":memory:");
});

describe("agoLabel", () => {
  it("reads naturally", () => {
    expect(agoLabel(1)).toBe("a month ago");
    expect(agoLabel(5)).toBe("5 months ago");
    expect(agoLabel(12)).toBe("a year ago");
    expect(agoLabel(24)).toBe("2 years ago");
  });
});

describe("onThisDay", () => {
  it("groups snips from the same day of earlier months", () => {
    addEpisode("e1", "2026-06-21");
    addEpisode("e2", "2026-05-21");
    addSnip("a", "e1");
    addSnip("b", "e2");
    const { groups } = onThisDay(db, { today: TODAY });
    expect(groups.map((g) => g.label)).toEqual(["a month ago", "2 months ago"]);
    expect(groups[0].snips.map((s) => s.id)).toEqual(["a"]);
  });

  it("ignores today and other days of the month", () => {
    addEpisode("today", TODAY);
    addEpisode("other", "2026-06-14");
    addSnip("a", "today");
    addSnip("b", "other");
    expect(onThisDay(db, { today: TODAY }).groups).toHaveLength(0);
  });

  it("reports how far back the library reaches, so an empty page can explain itself", () => {
    addEpisode("e1", "2026-01-26");
    addSnip("a", "e1");
    expect(onThisDay(db, { today: TODAY }).historyStart).toBe("2026-01-26");
  });

  it("leads a group with favorites and caps its size", () => {
    addEpisode("e1", "2026-06-21");
    for (let i = 0; i < 8; i++) addSnip(`s${i}`, "e1");
    addSnip("fav", "e1", { favorited: 1 });
    const { groups } = onThisDay(db, { today: TODAY, perGroup: 3 });
    expect(groups[0].snips).toHaveLength(3);
    expect(groups[0].snips[0].id).toBe("fav");
  });
});

describe("serendipity", () => {
  it("returns nothing when everything has been resurfaced", () => {
    addEpisode("e1", "2026-02-01");
    addSnip("a", "e1");
    recordReview(db, "a", "keep", { today: TODAY });
    expect(serendipity(db)).toBeNull();
  });

  it("prefers a favorite that has never been shown", () => {
    addEpisode("e1", "2026-02-01");
    addSnip("plain", "e1");
    addSnip("fav", "e1", { favorited: 1 });
    expect(serendipity(db, { seed: 0 })?.id).toBe("fav");
  });

  it("never returns a muted snip", () => {
    addEpisode("e1", "2026-02-01");
    addSnip("a", "e1");
    recordReview(db, "a", "mute", { today: TODAY });
    expect(serendipity(db)).toBeNull();
  });
});

describe("weeklyDigest", () => {
  it("counts the week just gone, not older material", () => {
    addEpisode("recent", "2026-07-18");
    addEpisode("old", "2026-03-01");
    addSnip("a", "recent");
    addSnip("b", "recent");
    addSnip("c", "old");
    const d = weeklyDigest(db, { today: TODAY });
    expect(d.snips).toBe(2);
    expect(d.episodes).toBe(1);
    expect(d.from).toBe("2026-07-14");
  });

  it("says so plainly when nothing was snipped", () => {
    addEpisode("old", "2026-03-01");
    addSnip("a", "old");
    expect(weeklyDigest(db, { today: TODAY }).narrative).toMatch(/Nothing new was snipped/);
  });

  it("surfaces older never-resurfaced snips as gems", () => {
    addEpisode("old", "2026-03-01");
    addSnip("gem", "old", { favorited: 1 });
    const d = weeklyDigest(db, { today: TODAY });
    expect(d.gems.map((g) => g.id)).toContain("gem");
  });

  it("does not offer a gem that has already been resurfaced", () => {
    addEpisode("old", "2026-03-01");
    addSnip("gem", "old", { favorited: 1 });
    recordReview(db, "gem", "keep", { today: TODAY });
    expect(weeklyDigest(db, { today: TODAY }).gems).toHaveLength(0);
  });

  it("ranks emerging topics by growth over the previous week", () => {
    addEpisode("thisWeek", "2026-07-18");
    addEpisode("lastWeek", "2026-07-10");
    db.exec(`INSERT INTO clusters (id, label, terms_json, size, model) VALUES (1,'Prayer','[]',0,'m')`);
    db.exec(`INSERT INTO clusters (id, label, terms_json, size, model) VALUES (2,'Money','[]',0,'m')`);
    for (let i = 0; i < 5; i++) {
      addSnip(`n${i}`, "thisWeek");
      db.prepare(`INSERT INTO snip_clusters (snip_id, cluster_id, similarity) VALUES (?, 1, 0.5)`).run(`n${i}`);
    }
    for (let i = 0; i < 4; i++) {
      addSnip(`m${i}`, "thisWeek");
      db.prepare(`INSERT INTO snip_clusters (snip_id, cluster_id, similarity) VALUES (?, 2, 0.5)`).run(`m${i}`);
    }
    for (let i = 0; i < 4; i++) {
      addSnip(`p${i}`, "lastWeek");
      db.prepare(`INSERT INTO snip_clusters (snip_id, cluster_id, similarity) VALUES (?, 2, 0.5)`).run(`p${i}`);
    }
    const t = weeklyDigest(db, { today: TODAY }).emergingTopics;
    expect(t[0].label).toBe("Prayer"); // +5 vs Money's 0
    expect(t[0].change).toBe(5);
  });
});

describe("digestRss", () => {
  it("produces a feed with an item for a week that had activity", () => {
    addEpisode("recent", "2026-07-18");
    addSnip("a", "recent");
    const xml = digestRss(db, "http://127.0.0.1:7433", { weeks: 2, today: TODAY });
    expect(xml).toContain("<rss version=\"2.0\">");
    expect(xml).toContain("Resurface: week to 2026-07-21");
    expect(xml).toContain("<guid isPermaLink=\"false\">resurface-digest-2026-07-21</guid>");
  });

  it("escapes titles that would otherwise break the XML", () => {
    addEpisode("recent", "2026-07-18", "s&1");
    addSnip("a", "recent");
    const xml = digestRss(db, "http://127.0.0.1:7433", { weeks: 1, today: TODAY });
    expect(xml).not.toMatch(/<description>[^<]*&(?!amp;|lt;|gt;|apos;|quot;)/);
  });
});
