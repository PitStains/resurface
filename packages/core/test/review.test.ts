import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { REVIEW_INTERVALS, recordReview, reviewQueue, reviewStats, seedForDate } from "../src/review.ts";

const TODAY = "2026-07-21";

let db: DatabaseSync;

function addSnip(
  id: string,
  opts: { kind?: string; favorited?: number; date?: string; quote?: string } = {}
) {
  db.prepare(
    `INSERT INTO snips (id, episode_id, ord, title, quote_text, summary_md, favorited, kind)
     VALUES (?, 'e1', 1, ?, ?, ?, ?, ?)`
  ).run(
    id,
    `Title ${id}`,
    opts.quote ?? "A quote long enough to be worth reading on its own, comfortably past the minimum.",
    "summary",
    opts.favorited ?? 0,
    opts.kind ?? "auto"
  );
  if (opts.date) db.prepare(`UPDATE episodes SET last_snip_date = ? WHERE id = 'e1'`).run(opts.date);
}

beforeEach(() => {
  db = openDb(":memory:");
  db.exec(`INSERT INTO shows (id, title) VALUES ('s1','Show')`);
  db.exec(`INSERT INTO episodes (id, show_id, title, last_snip_date) VALUES ('e1','s1','Ep','2026-01-10')`);
});

describe("reviewQueue", () => {
  it("returns the requested number of cards", () => {
    for (let i = 0; i < 40; i++) addSnip(`s${i}`);
    expect(reviewQueue(db, { size: 5, today: TODAY })).toHaveLength(5);
  });

  it("is stable for the same day and differs across days", () => {
    for (let i = 0; i < 60; i++) addSnip(`s${i}`);
    const a = reviewQueue(db, { size: 5, today: TODAY }).map((c) => c.id);
    const b = reviewQueue(db, { size: 5, today: TODAY }).map((c) => c.id);
    expect(a).toEqual(b); // reloading must not reshuffle
    const c = reviewQueue(db, { size: 5, today: "2026-07-22" }).map((x) => x.id);
    expect(c).not.toEqual(a);
  });

  it("honours the manual quota when enough manual snips exist", () => {
    for (let i = 0; i < 30; i++) addSnip(`a${i}`, { kind: "auto" });
    for (let i = 0; i < 30; i++) addSnip(`m${i}`, { kind: "manual" });
    const q = reviewQueue(db, { size: 5, manualQuota: 3, today: TODAY });
    expect(q.filter((c) => c.kind === "manual").length).toBe(3);
  });

  it("still fills the batch when there are barely any manual snips", () => {
    for (let i = 0; i < 30; i++) addSnip(`a${i}`, { kind: "auto" });
    addSnip("m1", { kind: "manual" });
    const q = reviewQueue(db, { size: 5, manualQuota: 3, today: TODAY });
    expect(q).toHaveLength(5);
    expect(q.filter((c) => c.kind === "manual").length).toBe(1);
  });

  it("skips snips with nothing substantial to read", () => {
    addSnip("thin", { quote: "too short" });
    db.prepare(`UPDATE snips SET summary_md = '' WHERE id = 'thin'`).run();
    for (let i = 0; i < 10; i++) addSnip(`s${i}`);
    expect(reviewQueue(db, { size: 10, today: TODAY }).map((c) => c.id)).not.toContain("thin");
  });

  it("explains why each card was chosen", () => {
    for (let i = 0; i < 20; i++) addSnip(`s${i}`);
    for (const card of reviewQueue(db, { size: 5, today: TODAY })) expect(card.reason.length).toBeGreaterThan(0);
  });

  it("excludes muted snips but leaves them in the library", () => {
    for (let i = 0; i < 12; i++) addSnip(`s${i}`);
    recordReview(db, "s3", "mute", { today: TODAY });
    const ids = reviewQueue(db, { size: 12, today: TODAY }).map((c) => c.id);
    expect(ids).not.toContain("s3");
    expect((db.prepare(`SELECT COUNT(*) c FROM snips WHERE id='s3'`).get() as { c: number }).c).toBe(1);
  });

  it("does not show a snip again before it is due", () => {
    for (let i = 0; i < 12; i++) addSnip(`s${i}`);
    recordReview(db, "s2", "keep", { today: TODAY });
    const ids = reviewQueue(db, { size: 12, today: TODAY }).map((c) => c.id);
    expect(ids).not.toContain("s2");
  });

  it("brings a snip back once its interval has elapsed", () => {
    addSnip("only");
    recordReview(db, "only", "keep", { today: TODAY }); // level 0 → 3 days
    expect(reviewQueue(db, { size: 5, today: "2026-07-23" })).toHaveLength(0);
    expect(reviewQueue(db, { size: 5, today: "2026-07-24" }).map((c) => c.id)).toEqual(["only"]);
  });
});

describe("recordReview", () => {
  beforeEach(() => addSnip("a"));

  it("widens the interval each time it is kept", () => {
    let r = recordReview(db, "a", "keep", { today: TODAY });
    expect(r.level).toBe(1);
    expect(r.dueDate).toBe("2026-07-24"); // the first gap is 3 days, not 7
    r = recordReview(db, "a", "keep", { today: TODAY });
    expect(r.level).toBe(2);
    expect(r.dueDate).toBe("2026-07-28"); // then 7
  });

  it("stops widening at the longest interval", () => {
    for (let i = 0; i < 10; i++) recordReview(db, "a", "keep", { today: TODAY });
    const row = db.prepare(`SELECT level FROM review_state WHERE snip_id='a'`).get() as { level: number };
    expect(row.level).toBe(REVIEW_INTERVALS.length - 1);
  });

  it("'more' pulls a snip back in", () => {
    recordReview(db, "a", "keep", { today: TODAY });
    recordReview(db, "a", "keep", { today: TODAY });
    expect(recordReview(db, "a", "more", { today: TODAY }).level).toBe(1);
  });

  it("'less' pushes it far out without muting it", () => {
    const r = recordReview(db, "a", "less", { today: TODAY });
    expect(r.muted).toBe(false);
    expect(r.dueDate).toBe("2027-01-17"); // 180 days
  });

  it("counts every showing and logs every action", () => {
    recordReview(db, "a", "keep", { today: TODAY });
    recordReview(db, "a", "more", { today: TODAY });
    const row = db.prepare(`SELECT times_shown FROM review_state WHERE snip_id='a'`).get() as {
      times_shown: number;
    };
    expect(row.times_shown).toBe(2);
    expect((db.prepare(`SELECT COUNT(*) c FROM review_log`).get() as { c: number }).c).toBe(2);
  });
});

describe("reviewStats", () => {
  it("counts what has and hasn't been seen", () => {
    for (let i = 0; i < 10; i++) addSnip(`s${i}`);
    expect(reviewStats(db, { today: TODAY })).toMatchObject({ eligible: 10, neverSeen: 10, reviewed: 0 });
    recordReview(db, "s0", "keep", { today: TODAY });
    recordReview(db, "s1", "mute", { today: TODAY });
    expect(reviewStats(db, { today: TODAY })).toMatchObject({ reviewed: 2, seenSnips: 2, muted: 1, neverSeen: 8 });
  });
});

describe("seedForDate", () => {
  it("is stable and date-dependent", () => {
    expect(seedForDate("2026-07-21")).toBe(seedForDate("2026-07-21"));
    expect(seedForDate("2026-07-21")).not.toBe(seedForDate("2026-07-22"));
  });
});
