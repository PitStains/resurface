import type { DatabaseSync } from "node:sqlite";

/**
 * Resurfacing (Phase 5): bringing back what you've forgotten.
 *
 * The library is ~32k snips and grows by roughly 5,800 a month, so the great
 * majority will never be seen again by chance. This picks a handful a day.
 *
 * Two things shape the choice. **Spaced repetition** decides when something
 * already seen comes back: keeping a snip pushes it out along a widening
 * interval, so the ones you value stop crowding the queue without being lost.
 * **Weighted sampling** decides what gets seen in the first place, favouring
 * snips never shown, snips you starred in Snipd, and older material — because
 * "I've forgotten most of it" is a statement about the back catalogue.
 *
 * A deliberate restraint: nothing here deletes or hides. "Mute" removes a snip
 * from review only; it stays in the library, search, stats and exports.
 */

/** Widening gaps, in days. Level N means "next seen in REVIEW_INTERVALS[N]". */
export const REVIEW_INTERVALS = [3, 7, 21, 60, 180] as const;

export type ReviewAction = "keep" | "more" | "less" | "mute";

export interface ReviewOptions {
  size?: number;
  /**
   * How many of the batch should be snips you made by hand. Hand-made snips
   * are the deliberate ones, but a review drawn only from them would never
   * revisit the 28k auto highlights — which are the better source of surprise
   * precisely because you didn't choose them.
   */
  manualQuota?: number;
  /** Fixed seed makes "today's five" stable across reloads. */
  seed?: number;
  today?: string;
}

export interface ReviewCard {
  id: string;
  title: string | null;
  quoteText: string | null;
  summaryMd: string | null;
  startSec: number | null;
  shareUrl: string | null;
  favorited: number;
  kind: string;
  showId: string;
  showTitle: string;
  episodeId: string;
  episodeTitle: string;
  lastSnipDate: string | null;
  topicLabel: string | null;
  timesShown: number;
  lastShownAt: string | null;
  /** Plain-language "why you're seeing this", shown on the card. */
  reason: string;
}

const today = (t?: string) => t ?? new Date().toISOString().slice(0, 10);

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Deterministic PRNG so a given day's batch is reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable integer for a date, so "today" seeds itself. */
export function seedForDate(date: string): number {
  let h = 0;
  for (const ch of date) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return h >>> 0;
}

interface Candidate {
  id: string;
  favorited: number;
  kind: string;
  lastSnipDate: string | null;
  timesShown: number;
  dueDate: string | null;
  weight: number;
  reason: string;
}

/**
 * Weight a snip's chance of being drawn. Multiplicative so each factor is
 * independent and legible; the reason string reports whichever dominated.
 */
function weigh(row: Omit<Candidate, "weight" | "reason">, now: string): { weight: number; reason: string } {
  let weight = 1;
  let reason = "a snip you haven't looked at in a while";

  if (row.dueDate && row.dueDate <= now) {
    weight *= 4;
    reason = "you asked to see this again";
  } else if (row.timesShown === 0) {
    weight *= 2.5;
    reason = "you've never seen this since you snipped it";
  }
  if (row.favorited) {
    weight *= 2;
    if (row.timesShown === 0) reason = "you starred this in Snipd and haven't seen it since";
  }
  // Age: older material is the point of the exercise. Roughly doubles per year.
  if (row.lastSnipDate) {
    const months = Math.max(0, (Date.parse(now) - Date.parse(row.lastSnipDate)) / (1000 * 60 * 60 * 24 * 30));
    weight *= 1 + Math.min(months, 36) / 12;
    if (months >= 6 && row.timesShown === 0 && !row.favorited)
      reason = `from ${Math.round(months)} months ago, and never resurfaced`;
  }
  // Seen a lot already: back off sharply rather than excluding.
  weight /= 1 + row.timesShown * row.timesShown;
  return { weight, reason };
}

/** Sample without replacement, proportional to weight. */
function sampleWeighted<T extends { weight: number }>(items: T[], n: number, rnd: () => number): T[] {
  const pool = [...items];
  const out: T[] = [];
  let total = pool.reduce((s, i) => s + i.weight, 0);
  while (out.length < n && pool.length > 0 && total > 0) {
    let r = rnd() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].weight;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    total -= pool[idx].weight;
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * Today's review batch. Deterministic for a given day, so reloading the page
 * doesn't reshuffle the cards out from under you.
 */
export function reviewQueue(db: DatabaseSync, opts: ReviewOptions = {}): ReviewCard[] {
  const size = opts.size ?? 5;
  const now = today(opts.today);
  const manualQuota = Math.min(opts.manualQuota ?? 3, size);
  const rnd = mulberry32(opts.seed ?? seedForDate(now));

  const rows = db
    .prepare(
      `SELECT s.id, s.favorited, s.kind, e.last_snip_date AS lastSnipDate,
              COALESCE(r.times_shown, 0) AS timesShown, r.due_date AS dueDate
       FROM snips s
       JOIN episodes e ON e.id = s.episode_id
       LEFT JOIN review_state r ON r.snip_id = s.id
       WHERE s.archived = 0
         AND COALESCE(r.muted, 0) = 0
         AND (r.due_date IS NULL OR r.due_date <= ?)
         -- Something has to be worth reading on its own.
         AND (LENGTH(COALESCE(s.quote_text,'')) > 40 OR LENGTH(COALESCE(s.summary_md,'')) > 80)`
    )
    .all(now) as unknown as Omit<Candidate, "weight" | "reason">[];

  const candidates: Candidate[] = rows.map((r) => ({ ...r, ...weigh(r, now) }));
  const manual = candidates.filter((c) => c.kind === "manual");
  const auto = candidates.filter((c) => c.kind !== "manual");

  // Fill the manual quota first, then top up from everything left over, so a
  // thin manual pool never shrinks the batch.
  const picked = sampleWeighted(manual, Math.min(manualQuota, manual.length), rnd);
  const chosen = new Set(picked.map((p) => p.id));
  picked.push(...sampleWeighted(auto, size - picked.length, rnd));
  for (const p of picked) chosen.add(p.id);
  if (picked.length < size)
    picked.push(...sampleWeighted(candidates.filter((c) => !chosen.has(c.id)), size - picked.length, rnd));

  return picked.map((c) => hydrateCard(db, c));
}

function hydrateCard(db: DatabaseSync, c: Candidate): ReviewCard {
  const row = db
    .prepare(
      `SELECT s.id, s.title, s.quote_text AS quoteText, s.summary_md AS summaryMd,
              s.start_sec AS startSec, s.share_url AS shareUrl, s.favorited, s.kind,
              sh.id AS showId, sh.title AS showTitle,
              e.id AS episodeId, e.title AS episodeTitle, e.last_snip_date AS lastSnipDate,
              cl.label AS topicLabel,
              COALESCE(r.times_shown, 0) AS timesShown, r.last_shown_at AS lastShownAt
       FROM snips s
       JOIN episodes e ON e.id = s.episode_id
       JOIN shows sh ON sh.id = e.show_id
       LEFT JOIN snip_clusters sc ON sc.snip_id = s.id
       LEFT JOIN clusters cl ON cl.id = sc.cluster_id
       LEFT JOIN review_state r ON r.snip_id = s.id
       WHERE s.id = ?`
    )
    .get(c.id) as unknown as Omit<ReviewCard, "reason">;
  return { ...row, reason: c.reason };
}

/**
 * Record what you did with a card.
 *
 * "keep" advances the interval; "more" pulls it back in; "less" pushes it far
 * out without muting it, because wanting less of something is not the same as
 * never wanting it again.
 */
export function recordReview(
  db: DatabaseSync,
  snipId: string,
  action: ReviewAction,
  opts: { today?: string } = {}
): { level: number; dueDate: string | null; muted: boolean } {
  const now = today(opts.today);
  const current = db.prepare(`SELECT level, times_shown FROM review_state WHERE snip_id = ?`).get(snipId) as
    | { level: number; times_shown: number }
    | undefined;
  const level = current?.level ?? 0;

  const last = REVIEW_INTERVALS.length - 1;
  let nextLevel = level;
  // The gap in force right now — applied before widening, so the first "keep"
  // schedules 3 days out rather than skipping straight to 7.
  let dueLevel = level;
  let muted = false;
  switch (action) {
    case "keep":
      dueLevel = level;
      nextLevel = Math.min(level + 1, last);
      break;
    case "more":
      nextLevel = Math.max(level - 1, 0);
      dueLevel = nextLevel;
      break;
    case "less":
      nextLevel = last;
      dueLevel = last;
      break;
    case "mute":
      muted = true;
      break;
  }
  const dueDate = muted ? null : addDays(now, REVIEW_INTERVALS[dueLevel]);

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO review_state (snip_id, level, due_date, times_shown, last_shown_at, muted)
       VALUES (?, ?, ?, 1, datetime('now'), ?)
       ON CONFLICT(snip_id) DO UPDATE SET level = excluded.level, due_date = excluded.due_date,
         times_shown = review_state.times_shown + 1, last_shown_at = excluded.last_shown_at,
         muted = excluded.muted`
    ).run(snipId, nextLevel, dueDate, muted ? 1 : 0);
    db.prepare(`INSERT INTO review_log (snip_id, action) VALUES (?, ?)`).run(snipId, action);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { level: nextLevel, dueDate, muted };
}

export interface ReviewStats {
  reviewed: number;
  seenSnips: number;
  muted: number;
  dueToday: number;
  neverSeen: number;
  eligible: number;
}

export function reviewStats(db: DatabaseSync, opts: { today?: string } = {}): ReviewStats {
  const now = today(opts.today);
  const one = (sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { c: number }).c;
  const eligible = one(
    `SELECT COUNT(*) c FROM snips s WHERE s.archived = 0
     AND (LENGTH(COALESCE(s.quote_text,'')) > 40 OR LENGTH(COALESCE(s.summary_md,'')) > 80)`
  );
  return {
    reviewed: one(`SELECT COUNT(*) c FROM review_log`),
    seenSnips: one(`SELECT COUNT(*) c FROM review_state WHERE times_shown > 0`),
    muted: one(`SELECT COUNT(*) c FROM review_state WHERE muted = 1`),
    dueToday: one(`SELECT COUNT(*) c FROM review_state WHERE muted = 0 AND due_date IS NOT NULL AND due_date <= ?`, now),
    neverSeen: eligible - one(`SELECT COUNT(*) c FROM review_state WHERE times_shown > 0`),
    eligible,
  };
}
