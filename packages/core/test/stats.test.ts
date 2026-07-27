import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { importVault } from "../src/import.ts";
import {
  computeStreaks,
  getActivity,
  getCalendar,
  getOverview,
  getShowStats,
  getWrapped,
  mergeIntervalsTotal,
} from "../src/stats.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "vault", "Data");
const TODAY = "2026-07-01";

/*
 * Fixture ground truth (hand-computed from actual time ranges — Snipd's "(02:05)"
 * labels are rounded and one second short of end−start in places):
 *  interview   2026-03-12  dur 3930s  snips (192→318)=126s + (2460→2670)=210s = 336s
 *  sectioned   2026-03-12  dur  600s  snip  (60→120)  = 60s   (same show as interview)
 *  devotional  2026-03-12  dur  172s  snip  (9→72)    = 63s
 *  uploads     2026-04-01  dur 7200s  snip  (600→720) = 120s
 *  at-sign     2026-06-23  dur 2160s  snip  (60→120)  = 60s
 *  hash-title  2026-04-16  dur 1380s  snip  (120→180) = 60s
 *  mojibake    2026-06-16  dur 3360s  snip  (202→282) = 80s
 *  broken      no snips → excluded everywhere
 */
let db: DatabaseSync;
beforeAll(() => {
  db = openDb(":memory:");
  importVault(db, FIXTURES);
});

describe("mergeIntervalsTotal", () => {
  it("merges overlapping and touching intervals", () => {
    expect(
      mergeIntervalsTotal([
        { start: 0, end: 100 },
        { start: 50, end: 150 }, // overlap → union 0-150
        { start: 150, end: 200 }, // touching → extends to 200
        { start: 300, end: 310 }, // disjoint
      ])
    ).toBe(210);
    expect(mergeIntervalsTotal([])).toBe(0);
    expect(mergeIntervalsTotal([{ start: 10, end: 5 }])).toBe(0); // invalid dropped
  });
});

describe("computeStreaks", () => {
  it("finds best and current runs with a yesterday grace", () => {
    const dates = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-10"];
    expect(computeStreaks(dates, "2026-01-03")).toEqual({ current: 3, best: 3 });
    expect(computeStreaks(dates, "2026-01-04")).toEqual({ current: 3, best: 3 }); // grace
    expect(computeStreaks(dates, "2026-01-06")).toEqual({ current: 0, best: 3 });
    expect(computeStreaks([], "2026-01-01")).toEqual({ current: 0, best: 0 });
  });
});

describe("getOverview", () => {
  it("all-time totals match hand-computed fixture values", () => {
    const o = getOverview(db, "all", TODAY);
    expect(o.episodes).toBe(7);
    expect(o.snips).toBe(8);
    expect(o.shows).toBe(6);
    expect(o.estimatedSec).toBe(3930 + 600 + 172 + 7200 + 2160 + 1380 + 3360);
    expect(o.snipSec).toBe(336 + 60 + 63 + 120 + 60 + 60 + 80);
    expect(o.previous).toBeNull();
    expect(o.streak.best).toBe(1); // no consecutive fixture days
  });

  it("month window (30d ending 2026-07-01) sees only June episodes, with prev comparison", () => {
    const o = getOverview(db, "month", TODAY);
    expect(o.from).toBe("2026-06-02");
    expect(o.episodes).toBe(2); // at-sign 06-23, mojibake 06-16
    expect(o.estimatedSec).toBe(2160 + 3360);
    expect(o.snipSec).toBe(60 + 80);
    // previous window 2026-05-03 → 2026-06-01: nothing
    expect(o.previous).toEqual({ episodes: 0, snips: 0, estimatedSec: 0, snipSec: 0 });
  });
});

describe("getShowStats", () => {
  it("computes per-show lenses", () => {
    const rows = getShowStats(db, "all", TODAY);
    expect(rows).toHaveLength(6); // broken show has no snips → excluded
    const uploads = rows.find((r) => r.title === "Your uploads")!;
    expect(uploads.estimatedSec).toBe(7200);
    expect(uploads.snips).toBe(1);
    expect(uploads.snipsPerHour).toBe(0.5);
    expect(rows[0].estimatedSec).toBe(7200); // sorted by estimated desc
  });
});

describe("getActivity", () => {
  it("zero-fills days and attributes episodes to their snip date", () => {
    const days = getActivity(db, "month", "day", TODAY);
    expect(days).toHaveLength(30);
    const jun23 = days.find((d) => d.date === "2026-06-23")!;
    expect(jun23.episodes).toBe(1);
    expect(jun23.snips).toBe(1);
    expect(jun23.estimatedSec).toBe(2160);
    expect(days.filter((d) => d.episodes > 0)).toHaveLength(2);
  });
});

describe("getCalendar / getWrapped", () => {
  it("calendar lists active days for the year", () => {
    const cal = getCalendar(db, 2026);
    expect(cal.map((c) => c.date)).toEqual([
      "2026-03-12",
      "2026-04-01",
      "2026-04-16",
      "2026-06-16",
      "2026-06-23",
    ]);
    const mar12 = cal[0];
    expect(mar12.episodes).toBe(3);
    expect(mar12.snips).toBe(4);
  });

  it("wrapped aggregates the year", () => {
    const w = getWrapped(db, 2026);
    expect(w.episodes).toBe(7);
    expect(w.snips).toBe(8);
    expect(w.activeDays).toBe(5);
    expect(w.biggestMonths[0]).toEqual({ month: "2026-03", episodes: 3, snips: 4 });
    expect(w.longestEpisodes[0].durationSec).toBe(7200);
    expect(w.topShows[0].title).toBe("Your uploads");
  });

  it("wrapped returns every show so the page can offer top 10/25/50/all", () => {
    const w = getWrapped(db, 2026);
    expect(w.topShows).toHaveLength(6);
    expect(w.totalShows).toBe(6);
    // Re-ranking by episodes is what surfaces short shows the hours lens hides.
    const byEpisodes = [...w.topShows].sort((a, b) => b.episodes - a.episodes);
    expect(byEpisodes[0].episodes).toBe(2); // the interview show has two episodes
  });

  it("wrapped computes the fun stats from existing data", () => {
    const w = getWrapped(db, 2026);
    expect(w.busiestDays[0]).toEqual({ date: "2026-03-12", episodes: 3, snips: 4 });
    expect(w.longestStreak).toBe(1); // no consecutive fixture days
    expect(w.quotes).toBe(1);
    expect(w.favorites).toBe(1);
    expect(w.mostSnippedEpisodes[0].snips).toBe(2); // "Building Better Habits"
    expect(w.months).toHaveLength(12);
    expect(w.months[2]).toEqual({ month: "2026-03", episodes: 3, snips: 4, estimatedSec: 3930 + 600 + 172 });
    expect(w.weekdays).toHaveLength(7);
    expect(w.weekdays.find((d) => d.day === "Thursday")?.episodes).toBe(4); // 3 on 2026-03-12 + 2026-04-16
    expect(w.topTags[0]).toMatchObject({ key: "grace", count: 3 });
    expect(w.previous).toBeNull(); // no 2025 data
  });

  it("wrapped can narrow to a single month, with the same month last year to compare", () => {
    const march = getWrapped(db, 2026, 3);
    expect(march.month).toBe(3);
    expect(march.episodes).toBe(3); // interview + sectioned + devotional, all 2026-03-12
    expect(march.snips).toBe(4);
    expect(march.busiestDays).toEqual([{ date: "2026-03-12", episodes: 3, snips: 4 }]);
    expect(march.previous).toBeNull(); // no March 2025 data

    const april = getWrapped(db, 2026, 4);
    expect(april.episodes).toBe(2); // uploads 04-01, hash-title 04-16
    expect(getWrapped(db, 2026, 12).episodes).toBe(0);
    // The whole-year view is unchanged by the month parameter being absent.
    expect(getWrapped(db, 2026).month).toBeNull();
  });

  it("wrapped ranks favorites by show and returns lists the page can slice", () => {
    const w = getWrapped(db, 2026);
    expect(w.favoriteShows[0]).toEqual({
      id: expect.any(String),
      title: "Daily Example Devotional",
      favorites: 1,
    });
    expect(w.longestEpisodes.length).toBeGreaterThan(1); // a list now, not one episode
    expect(w.busiestDays.length).toBeGreaterThan(1);
    expect(w.densestEpisodes.every((e) => (e.durationSec ?? 0) >= 600)).toBe(true);
  });

  it("wrapped buckets episodes by length and guards the density leaderboard", () => {
    const w = getWrapped(db, 2026);
    const byLabel = new Map(w.durationBuckets.map((b) => [b.label, b]));
    expect(byLabel.get("Under 10 min")!.episodes).toBe(2); // devotional 172s, sectioned 600s
    expect(byLabel.get("60 min+")!.episodes).toBe(2); // interview 3930s, uploads 7200s
    expect(w.durationBuckets.reduce((n, b) => n + b.episodes, 0)).toBe(7);
    // Every fixture show has 1–2 episodes, under the 3-episode volume guard.
    expect(w.densityLeaders).toEqual([]);
    expect(w.oneAndDone.length).toBeGreaterThan(0);
    expect(w.newShows.length).toBe(6); // every show was first snipped in 2026
  });
});
