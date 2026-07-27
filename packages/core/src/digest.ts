import type { DatabaseSync } from "node:sqlite";

/**
 * The rest of resurfacing (Phase 5): looking back by date, a weekly summary,
 * and one-click serendipity.
 *
 * A caveat that shapes all of this: the Snipd export carries no per-snip
 * timestamp, so everything is dated by its episode's `last_snip_date`. Every
 * "on this day" here is therefore accurate to the day an episode was last
 * snipped, not to the moment you pressed the button. That is stated in the UI
 * rather than hidden.
 */

export interface DatedSnip {
  id: string;
  title: string | null;
  quoteText: string | null;
  startSec: number | null;
  shareUrl: string | null;
  favorited: number;
  kind: string;
  showId: string;
  showTitle: string;
  episodeId: string;
  episodeTitle: string;
  lastSnipDate: string | null;
}

const SNIP_COLUMNS = `s.id, s.title, s.quote_text AS quoteText, s.start_sec AS startSec,
  s.share_url AS shareUrl, s.favorited, s.kind,
  sh.id AS showId, sh.title AS showTitle,
  e.id AS episodeId, e.title AS episodeTitle, e.last_snip_date AS lastSnipDate`;
const SNIP_JOINS = `FROM snips s
  JOIN episodes e ON e.id = s.episode_id
  JOIN shows sh ON sh.id = e.show_id`;
/** Worth reading on its own — the same bar the daily review uses. */
const SUBSTANTIAL = `(LENGTH(COALESCE(s.quote_text,'')) > 40 OR LENGTH(COALESCE(s.summary_md,'')) > 80)`;

const isoToday = (t?: string) => t ?? new Date().toISOString().slice(0, 10);

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/** "5 months ago", "a year ago" — the label on each group. */
export function agoLabel(months: number): string {
  if (months >= 12) {
    const years = Math.round(months / 12);
    return years === 1 ? "a year ago" : `${years} years ago`;
  }
  if (months === 1) return "a month ago";
  return `${months} months ago`;
}

export interface OnThisDayGroup {
  date: string;
  monthsAgo: number;
  label: string;
  snips: DatedSnip[];
}

/**
 * Snips from this same day in earlier months and years. With only a few months
 * of history there is no "last year" yet, so the caller is told how far back
 * the library actually reaches rather than shown an empty page.
 */
export function onThisDay(
  db: DatabaseSync,
  opts: { today?: string; perGroup?: number } = {}
): { groups: OnThisDayGroup[]; historyStart: string | null } {
  const now = isoToday(opts.today);
  const perGroup = opts.perGroup ?? 4;
  const day = now.slice(8, 10);

  const start = (
    db.prepare(`SELECT MIN(last_snip_date) d FROM episodes WHERE last_snip_date IS NOT NULL`).get() as {
      d: string | null;
    }
  ).d;

  // Same day-of-month, any earlier month. Favorites first so a group leads with
  // something you marked yourself.
  const rows = db
    .prepare(
      `SELECT ${SNIP_COLUMNS} ${SNIP_JOINS}
       WHERE s.archived = 0 AND ${SUBSTANTIAL}
         AND e.last_snip_date IS NOT NULL
         AND substr(e.last_snip_date, 9, 2) = ?
         AND e.last_snip_date < ?
       ORDER BY e.last_snip_date DESC, s.favorited DESC, s.id`
    )
    .all(day, now) as unknown as DatedSnip[];

  const byDate = new Map<string, DatedSnip[]>();
  for (const r of rows) {
    const key = r.lastSnipDate!;
    const list = byDate.get(key) ?? [];
    if (list.length < perGroup) list.push(r);
    byDate.set(key, list);
  }

  const groups = [...byDate.entries()]
    .map(([date, snips]) => {
      const monthsAgo = monthsBetween(date, now);
      return { date, monthsAgo, label: agoLabel(monthsAgo), snips };
    })
    .filter((g) => g.monthsAgo >= 1)
    .sort((a, b) => a.monthsAgo - b.monthsAgo);

  return { groups, historyStart: start };
}

/**
 * One snip, chosen for surprise: the oldest thing you have never had
 * resurfaced, weighted toward what you starred. Deliberately not the daily
 * review — this is the "show me something" button.
 */
export function serendipity(db: DatabaseSync, opts: { seed?: number } = {}): DatedSnip | null {
  const pool = db
    .prepare(
      `SELECT ${SNIP_COLUMNS} ${SNIP_JOINS}
       LEFT JOIN review_state r ON r.snip_id = s.id
       WHERE s.archived = 0 AND ${SUBSTANTIAL}
         AND COALESCE(r.times_shown, 0) = 0
         AND COALESCE(r.muted, 0) = 0
       ORDER BY s.favorited DESC, e.last_snip_date ASC
       LIMIT 200`
    )
    .all() as unknown as DatedSnip[];
  if (pool.length === 0) return null;
  // Pick from the oldest slice rather than always the single oldest, so the
  // button doesn't return the same snip until it happens to be reviewed.
  const seed = opts.seed ?? Date.now();
  return pool[seed % pool.length];
}

export interface DigestTopic {
  label: string;
  snips: number;
  previous: number;
  change: number;
}

export interface WeeklyDigest {
  from: string;
  to: string;
  episodes: number;
  snips: number;
  shows: number;
  favorites: number;
  topShows: { id: string; title: string; snips: number }[];
  emergingTopics: DigestTopic[];
  gems: DatedSnip[];
  narrative: string;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The week just gone: what came in, which themes rose, and a few things worth
 * revisiting. The narrative is assembled from the numbers themselves — there is
 * no model involved, so the digest is always available and always accurate.
 */
export function weeklyDigest(db: DatabaseSync, opts: { today?: string } = {}): WeeklyDigest {
  const to = isoToday(opts.today);
  const from = addDays(to, -7);
  const prevFrom = addDays(to, -14);

  const counts = db
    .prepare(
      `SELECT COUNT(DISTINCT e.id) episodes, COUNT(s.id) snips,
              COUNT(DISTINCT e.show_id) shows,
              SUM(CASE WHEN s.favorited = 1 THEN 1 ELSE 0 END) favorites
       ${SNIP_JOINS}
       WHERE e.last_snip_date > ? AND e.last_snip_date <= ? AND s.archived = 0`
    )
    .get(from, to) as unknown as { episodes: number; snips: number; shows: number; favorites: number };

  const topShows = db
    .prepare(
      `SELECT sh.id, sh.title, COUNT(s.id) snips ${SNIP_JOINS}
       WHERE e.last_snip_date > ? AND e.last_snip_date <= ? AND s.archived = 0
       GROUP BY sh.id ORDER BY snips DESC LIMIT 5`
    )
    .all(from, to) as unknown as { id: string; title: string; snips: number }[];

  // Which topics grew relative to the week before — the "emerging themes".
  const topicCounts = (a: string, b: string) =>
    new Map(
      (
        db
          .prepare(
            `SELECT cl.label, COUNT(*) n
             FROM snips s
             JOIN episodes e ON e.id = s.episode_id
             JOIN snip_clusters sc ON sc.snip_id = s.id
             JOIN clusters cl ON cl.id = sc.cluster_id
             WHERE e.last_snip_date > ? AND e.last_snip_date <= ? AND s.archived = 0
             GROUP BY cl.label`
          )
          .all(a, b) as unknown as { label: string; n: number }[]
      ).map((r) => [r.label, r.n])
    );
  const thisWeek = topicCounts(from, to);
  const lastWeek = topicCounts(prevFrom, from);
  const emergingTopics: DigestTopic[] = [...thisWeek.entries()]
    .map(([label, snips]) => {
      const previous = lastWeek.get(label) ?? 0;
      return { label, snips, previous, change: snips - previous };
    })
    .filter((t) => t.snips >= 3)
    .sort((a, b) => b.change - a.change)
    .slice(0, 5);

  // Gems are older, favorited, and not yet resurfaced — the digest's reason to
  // exist is the back catalogue, not the week's intake.
  const gems = db
    .prepare(
      `SELECT ${SNIP_COLUMNS} ${SNIP_JOINS}
       LEFT JOIN review_state r ON r.snip_id = s.id
       WHERE s.archived = 0 AND ${SUBSTANTIAL}
         AND e.last_snip_date <= ?
         AND COALESCE(r.times_shown, 0) = 0 AND COALESCE(r.muted, 0) = 0
       ORDER BY s.favorited DESC, e.last_snip_date ASC LIMIT 3`
    )
    .all(from) as unknown as DatedSnip[];

  const parts: string[] = [];
  if (counts.snips > 0) {
    parts.push(
      `You snipped ${counts.snips} time${counts.snips === 1 ? "" : "s"} across ` +
        `${counts.episodes} episode${counts.episodes === 1 ? "" : "s"} from ${counts.shows} show${
          counts.shows === 1 ? "" : "s"
        }.`
    );
    if (topShows[0]) parts.push(`${topShows[0].title} led with ${topShows[0].snips}.`);
    const rising = emergingTopics.filter((t) => t.change > 0);
    if (rising.length > 0)
      parts.push(`Rising themes: ${rising.slice(0, 3).map((t) => `${t.label} (+${t.change})`).join(", ")}.`);
  } else {
    parts.push("Nothing new was snipped this week.");
  }
  if (gems.length > 0) parts.push(`${gems.length} older snips below have never been resurfaced.`);

  return {
    from,
    to,
    episodes: counts.episodes ?? 0,
    snips: counts.snips ?? 0,
    shows: counts.shows ?? 0,
    favorites: counts.favorites ?? 0,
    topShows,
    emergingTopics,
    gems,
    narrative: parts.join(" "),
  };
}

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/**
 * The digest as a feed, so it can be read in any reader. Pull, not push —
 * there is no reliable free SMTP, and a feed needs no account.
 */
export function digestRss(db: DatabaseSync, baseUrl: string, opts: { weeks?: number; today?: string } = {}): string {
  const weeks = opts.weeks ?? 8;
  const today = isoToday(opts.today);
  const items: string[] = [];
  for (let i = 0; i < weeks; i++) {
    const end = addDays(today, -7 * i);
    const d = weeklyDigest(db, { today: end });
    if (d.snips === 0 && d.gems.length === 0) continue;
    const body = [
      d.narrative,
      "",
      ...d.gems.map((g) => `• ${g.showTitle} — ${g.title ?? ""}: ${(g.quoteText ?? "").slice(0, 200)}`),
    ].join("\n");
    items.push(
      `    <item>
      <title>${escapeXml(`Resurface: week to ${d.to}`)}</title>
      <link>${escapeXml(`${baseUrl}/digest?week=${d.to}`)}</link>
      <guid isPermaLink="false">resurface-digest-${d.to}</guid>
      <pubDate>${new Date(`${d.to}T12:00:00Z`).toUTCString()}</pubDate>
      <description>${escapeXml(body)}</description>
    </item>`
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Resurface weekly digest</title>
    <link>${escapeXml(baseUrl)}</link>
    <description>What you snipped, what's rising, and what you'd forgotten.</description>
${items.join("\n")}
  </channel>
</rss>`;
}
