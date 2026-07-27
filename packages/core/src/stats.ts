import type { DatabaseSync } from "node:sqlite";

export type Period = "week" | "month" | "year" | "all";

const PERIOD_DAYS: Record<Period, number | null> = { week: 7, month: 30, year: 365, all: null };

/** Local calendar date as YYYY-MM-DD (date-only fields in the vault are local dates). */
function localToday(): string {
  return new Date().toLocaleDateString("sv-SE");
}

function addDays(date: string, days: number): string {
  const d = new Date(date + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("sv-SE");
}

/** [from, to] inclusive for a period ending today; null = all time. */
export function periodRange(period: Period, today: string = localToday()): { from: string | null; to: string } {
  const days = PERIOD_DAYS[period];
  return { from: days === null ? null : addDays(today, -(days - 1)), to: today };
}

/** Total seconds covered by the union of [start,end] intervals (overlaps merged). */
export function mergeIntervalsTotal(intervals: { start: number; end: number }[]): number {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const { start, end } of sorted) {
    if (start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = start;
      curEnd = end;
    } else if (end > curEnd) {
      curEnd = end;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

/**
 * Current & best streak over a set of active days.
 * Current streak = consecutive days ending today (or yesterday, so a streak
 * isn't "broken" before the day is over).
 */
export function computeStreaks(dates: string[], today: string): { current: number; best: number } {
  const days = [...new Set(dates)].sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  const runEnds = new Map<string, number>();
  for (const d of days) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    runEnds.set(d, run);
    if (run > best) best = run;
    prev = d;
  }
  const current = runEnds.get(today) ?? runEnds.get(addDays(today, -1)) ?? 0;
  return { current, best };
}

interface EpisodeRow {
  id: string;
  show_id: string;
  duration_sec: number | null;
  last_snip_date: string | null;
}

/** Episodes with ≥1 active snip in the date range, with their snip intervals. */
function episodesInRange(db: DatabaseSync, from: string | null, to: string) {
  // No archived filter: snips/episodes missing from the vault still count —
  // they were listened to, and the never-delete policy keeps them first-class.
  const where = from ? "e.last_snip_date >= ? AND e.last_snip_date <= ?" : "1 = 1";
  const params = from ? [from, to] : [];
  const episodes = db
    .prepare(
      `SELECT e.id, e.show_id, e.duration_sec, e.last_snip_date
       FROM episodes e WHERE ${where}
         AND EXISTS (SELECT 1 FROM snips s WHERE s.episode_id = e.id)`
    )
    .all(...params) as unknown as EpisodeRow[];
  const snips = db
    .prepare(
      `SELECT s.episode_id, s.start_sec, s.end_sec, s.duration_sec
       FROM snips s JOIN episodes e ON e.id = s.episode_id
       WHERE ${where}`
    )
    .all(...params) as unknown as {
    episode_id: string;
    start_sec: number | null;
    end_sec: number | null;
    duration_sec: number | null;
  }[];
  return { episodes, snips };
}

/**
 * "Snip time" = audio captured by snips, per-episode union of their time ranges
 * (overlaps counted once). This is a capture metric, NOT a listening bound —
 * listening time is the episode-duration number (see OverviewStats.estimatedSec).
 */
function snipSeconds(
  snips: { episode_id: string; start_sec: number | null; end_sec: number | null; duration_sec: number | null }[]
): number {
  const byEpisode = new Map<string, { start: number; end: number }[]>();
  let noRangeFallback = 0;
  for (const s of snips) {
    if (s.start_sec !== null && s.end_sec !== null && s.end_sec > s.start_sec) {
      let list = byEpisode.get(s.episode_id);
      if (!list) byEpisode.set(s.episode_id, (list = []));
      list.push({ start: s.start_sec, end: s.end_sec });
    } else if (s.duration_sec) {
      noRangeFallback += s.duration_sec;
    }
  }
  let total = noRangeFallback;
  for (const list of byEpisode.values()) total += mergeIntervalsTotal(list);
  return total;
}

export interface OverviewStats {
  period: Period;
  from: string | null;
  to: string;
  episodes: number;
  snips: number;
  shows: number;
  estimatedSec: number;
  snipSec: number;
  previous: { episodes: number; snips: number; estimatedSec: number; snipSec: number } | null;
  streak: { current: number; best: number };
}

export function getOverview(db: DatabaseSync, period: Period, today = localToday()): OverviewStats {
  const { from, to } = periodRange(period, today);
  const compute = (f: string | null, t: string) => {
    const { episodes, snips } = episodesInRange(db, f, t);
    return {
      episodes: episodes.length,
      snips: snips.length,
      shows: new Set(episodes.map((e) => e.show_id)).size,
      estimatedSec: episodes.reduce((acc, e) => acc + (e.duration_sec ?? 0), 0),
      snipSec: snipSeconds(snips),
    };
  };
  const cur = compute(from, to);

  let previous: OverviewStats["previous"] = null;
  if (from) {
    const days = PERIOD_DAYS[period]!;
    const prev = compute(addDays(from, -days), addDays(from, -1));
    previous = {
      episodes: prev.episodes,
      snips: prev.snips,
      estimatedSec: prev.estimatedSec,
      snipSec: prev.snipSec,
    };
  }

  const allDates = (
    db
      .prepare(
        `SELECT DISTINCT e.last_snip_date d FROM episodes e
         WHERE e.last_snip_date IS NOT NULL
           AND EXISTS (SELECT 1 FROM snips s WHERE s.episode_id = e.id)`
      )
      .all() as unknown as { d: string }[]
  ).map((r) => r.d);

  return { period, from, to, ...cur, previous, streak: computeStreaks(allDates, today) };
}

export interface ShowStatsRow {
  id: string;
  title: string;
  imageUrl: string | null;
  episodes: number;
  snips: number;
  estimatedSec: number;
  snipSec: number;
  /** Density per listening hour — structurally favors short episodes. */
  snipsPerHour: number | null;
  /** Density per episode — the opposite bias; shown alongside, never blended. */
  snipsPerEpisode: number | null;
  /** Mean episode length: what makes a show short- or long-form. */
  avgEpisodeSec: number | null;
  lastActivity: string | null;
}

export function getShowStats(db: DatabaseSync, period: Period, today = localToday()): ShowStatsRow[] {
  const { from, to } = periodRange(period, today);
  const { episodes, snips } = episodesInRange(db, from, to);
  const shows = db.prepare("SELECT id, title, image_url FROM shows").all() as unknown as {
    id: string;
    title: string;
    image_url: string | null;
  }[];
  const byShow = new Map<string, ShowStatsRow>();
  for (const s of shows)
    byShow.set(s.id, {
      id: s.id,
      title: s.title,
      imageUrl: s.image_url,
      episodes: 0,
      snips: 0,
      estimatedSec: 0,
      snipSec: 0,
      snipsPerHour: null,
      snipsPerEpisode: null,
      avgEpisodeSec: null,
      lastActivity: null,
    });
  const showOfEpisode = new Map<string, string>();
  for (const e of episodes) {
    const row = byShow.get(e.show_id);
    if (!row) continue;
    showOfEpisode.set(e.id, e.show_id);
    row.episodes++;
    row.estimatedSec += e.duration_sec ?? 0;
    if (e.last_snip_date && (!row.lastActivity || e.last_snip_date > row.lastActivity))
      row.lastActivity = e.last_snip_date;
  }
  const snipsByShow = new Map<string, typeof snips>();
  for (const s of snips) {
    const showId = showOfEpisode.get(s.episode_id);
    if (!showId) continue;
    byShow.get(showId)!.snips++;
    let list = snipsByShow.get(showId);
    if (!list) snipsByShow.set(showId, (list = []));
    list.push(s);
  }
  for (const [showId, list] of snipsByShow) byShow.get(showId)!.snipSec = snipSeconds(list);
  const rows = [...byShow.values()].filter((r) => r.episodes > 0);
  for (const r of rows) {
    r.snipsPerHour = r.estimatedSec > 0 ? +(r.snips / (r.estimatedSec / 3600)).toFixed(2) : null;
    r.snipsPerEpisode = +(r.snips / r.episodes).toFixed(2);
    r.avgEpisodeSec = r.estimatedSec > 0 ? Math.round(r.estimatedSec / r.episodes) : null;
  }
  return rows.sort((a, b) => b.estimatedSec - a.estimatedSec);
}

export interface ActivityBucket {
  date: string; // bucket start (day or ISO week start)
  episodes: number;
  snips: number;
  estimatedSec: number;
}

export function getActivity(
  db: DatabaseSync,
  period: Period,
  bucket: "day" | "week",
  today = localToday()
): ActivityBucket[] {
  const { from, to } = periodRange(period, today);
  const { episodes, snips } = episodesInRange(db, from, to);
  const snipsByEpisode = new Map<string, number>();
  for (const s of snips) snipsByEpisode.set(s.episode_id, (snipsByEpisode.get(s.episode_id) ?? 0) + 1);

  const keyOf = (date: string) => {
    if (bucket === "day") return date;
    const d = new Date(date + "T12:00:00");
    const dow = (d.getDay() + 6) % 7; // Monday-start week
    return addDays(date, -dow);
  };
  const map = new Map<string, ActivityBucket>();
  const start = from ?? episodes.reduce((m, e) => (e.last_snip_date && e.last_snip_date < m ? e.last_snip_date : m), to);
  // Zero-fill so charts show gaps honestly.
  for (let d = keyOf(start); d <= to; d = addDays(d, bucket === "day" ? 1 : 7))
    map.set(d, { date: d, episodes: 0, snips: 0, estimatedSec: 0 });
  for (const e of episodes) {
    if (!e.last_snip_date) continue;
    const key = keyOf(e.last_snip_date);
    const b = map.get(key);
    if (!b) continue;
    b.episodes++;
    b.snips += snipsByEpisode.get(e.id) ?? 0;
    b.estimatedSec += e.duration_sec ?? 0;
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface CalendarDay {
  date: string;
  episodes: number;
  snips: number;
}

export function getCalendar(db: DatabaseSync, year: number): CalendarDay[] {
  const rows = db
    .prepare(
      `SELECT e.last_snip_date d, COUNT(DISTINCT e.id) episodes, COUNT(s.id) snips
       FROM episodes e JOIN snips s ON s.episode_id = e.id
       WHERE e.last_snip_date LIKE ?
       GROUP BY e.last_snip_date ORDER BY d`
    )
    .all(`${year}-%`) as unknown as { d: string; episodes: number; snips: number }[];
  return rows.map((r) => ({ date: r.d, episodes: r.episodes, snips: r.snips }));
}

export interface WrappedShow {
  id: string;
  title: string;
  episodes: number;
  snips: number;
  estimatedSec: number;
  snipsPerHour: number | null;
  snipsPerEpisode: number;
  avgEpisodeSec: number | null;
}

export interface WrappedEpisode {
  id: string;
  title: string;
  show: string;
  snips: number;
  durationSec: number | null;
  snipsPerHour: number | null;
}

/** Episode-length buckets: how much of the year was short-form vs long-form. */
const DURATION_BUCKETS: { label: string; max: number | null }[] = [
  { label: "Under 10 min", max: 600 },
  { label: "10–30 min", max: 1800 },
  { label: "30–60 min", max: 3600 },
  { label: "60 min+", max: null },
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Shows need this much volume before density rankings take them seriously. */
export const DENSITY_MIN_EPISODES = 3;
export const DENSITY_MIN_SEC = 1800;

export interface WrappedStats {
  year: number;
  episodes: number;
  snips: number;
  shows: number;
  estimatedSec: number;
  snipSec: number;
  activeDays: number;
  quotes: number;
  favorites: number;
  /** The period covered: a whole year, or one month of it. */
  month: number | null;
  /**
   * Every list is returned ranked and generously long; the page slices each one
   * to the size the reader picks, so changing "top 5" to "top 25" needs no
   * round-trip.
   */
  topShows: WrappedShow[];
  totalShows: number;
  favoriteShows: { id: string; title: string; favorites: number }[];
  biggestMonths: { month: string; episodes: number; snips: number }[];
  longestEpisodes: WrappedEpisode[];
  mostSnippedEpisodes: WrappedEpisode[];
  densestEpisodes: WrappedEpisode[];
  densityLeaders: WrappedShow[];
  newShows: { id: string; title: string; episodes: number }[];
  oneAndDone: { id: string; title: string }[];
  busiestDays: { date: string; episodes: number; snips: number }[];
  longestStreak: number;
  months: { month: string; episodes: number; snips: number; estimatedSec: number }[];
  weekdays: { day: string; episodes: number; snips: number; estimatedSec: number }[];
  durationBuckets: { label: string; episodes: number; estimatedSec: number; snips: number }[];
  topTags: { key: string; label: string; count: number }[];
  books: number;
  guests: number;
  previous: { year: number; episodes: number; snips: number; estimatedSec: number } | null;
}

/** Last day of a month, so a month view covers exactly that month. */
function monthEnd(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  return `${year}-${String(month).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** How many rows each ranked list carries; the page picks how many to show. */
const LIST_CAP = 25;

export function getWrapped(db: DatabaseSync, year: number, month?: number | null): WrappedStats {
  const inMonth = month != null && month >= 1 && month <= 12;
  const from = inMonth ? `${year}-${String(month).padStart(2, "0")}-01` : `${year}-01-01`;
  const to = inMonth ? monthEnd(year, month!) : `${year}-12-31`;
  const { episodes, snips } = episodesInRange(db, from, to);
  const meta = new Map(
    (
      db.prepare("SELECT e.id, e.title, sh.id AS showId, sh.title AS showTitle FROM episodes e JOIN shows sh ON sh.id = e.show_id").all() as unknown as {
        id: string;
        title: string;
        showId: string;
        showTitle: string;
      }[]
    ).map((r) => [r.id, r])
  );
  const snipsByEpisode = new Map<string, number>();
  for (const s of snips) snipsByEpisode.set(s.episode_id, (snipsByEpisode.get(s.episode_id) ?? 0) + 1);

  const perShow = new Map<string, WrappedShow>();
  const months = new Map<string, { episodes: number; snips: number; estimatedSec: number }>();
  const weekdays = new Array(7).fill(null).map(() => ({ episodes: 0, snips: 0, estimatedSec: 0 }));
  const buckets = DURATION_BUCKETS.map((b) => ({ label: b.label, episodes: 0, estimatedSec: 0, snips: 0 }));
  const days = new Map<string, { episodes: number; snips: number }>();

  const asEpisode = (e: EpisodeRow): WrappedEpisode => {
    const m = meta.get(e.id);
    const n = snipsByEpisode.get(e.id) ?? 0;
    return {
      id: e.id,
      title: m?.title ?? "?",
      show: m?.showTitle ?? "?",
      snips: n,
      durationSec: e.duration_sec,
      snipsPerHour: e.duration_sec ? +(n / (e.duration_sec / 3600)).toFixed(1) : null,
    };
  };

  for (const e of episodes) {
    const n = snipsByEpisode.get(e.id) ?? 0;
    const dur = e.duration_sec ?? 0;
    const row = perShow.get(e.show_id) ?? {
      id: e.show_id,
      title: meta.get(e.id)?.showTitle ?? "?",
      episodes: 0,
      snips: 0,
      estimatedSec: 0,
      snipsPerHour: null,
      snipsPerEpisode: 0,
      avgEpisodeSec: null,
    };
    row.episodes++;
    row.snips += n;
    row.estimatedSec += dur;
    perShow.set(e.show_id, row);

    const bucket = buckets[DURATION_BUCKETS.findIndex((b) => b.max === null || dur <= b.max)];
    bucket.episodes++;
    bucket.estimatedSec += dur;
    bucket.snips += n;

    if (e.last_snip_date) {
      const m = months.get(e.last_snip_date.slice(0, 7)) ?? { episodes: 0, snips: 0, estimatedSec: 0 };
      m.episodes++;
      m.snips += n;
      m.estimatedSec += dur;
      months.set(e.last_snip_date.slice(0, 7), m);

      const d = days.get(e.last_snip_date) ?? { episodes: 0, snips: 0 };
      d.episodes++;
      d.snips += n;
      days.set(e.last_snip_date, d);

      const dow = new Date(e.last_snip_date + "T12:00:00").getDay();
      weekdays[dow].episodes++;
      weekdays[dow].snips += n;
      weekdays[dow].estimatedSec += dur;
    }
  }

  for (const row of perShow.values()) {
    row.snipsPerHour = row.estimatedSec > 0 ? +(row.snips / (row.estimatedSec / 3600)).toFixed(2) : null;
    row.snipsPerEpisode = +(row.snips / row.episodes).toFixed(2);
    row.avgEpisodeSec = row.estimatedSec > 0 ? Math.round(row.estimatedSec / row.episodes) : null;
  }

  const withSnips = episodes.filter((e) => (snipsByEpisode.get(e.id) ?? 0) > 0);
  const mostSnipped = [...withSnips]
    .sort((a, b) => (snipsByEpisode.get(b.id) ?? 0) - (snipsByEpisode.get(a.id) ?? 0))
    .slice(0, LIST_CAP)
    .map(asEpisode);
  const longestEpisodes = [...episodes]
    .filter((e) => e.duration_sec)
    .sort((a, b) => (b.duration_sec ?? 0) - (a.duration_sec ?? 0))
    .slice(0, LIST_CAP)
    .map(asEpisode);
  const densestEpisodes = [...withSnips]
    .map(asEpisode)
    // A five-minute clip with a couple of snips isn't "dense", it's just short.
    .filter((e) => (e.durationSec ?? 0) >= 600)
    .sort((a, b) => (b.snipsPerHour ?? 0) - (a.snipsPerHour ?? 0))
    .slice(0, LIST_CAP);

  const busiestDays = [...days.entries()]
    .map(([date, d]) => ({ date, ...d }))
    .sort((a, b) => b.snips - a.snips)
    .slice(0, LIST_CAP);
  const firstYearByShow = db
    .prepare(
      `SELECT sh.id, sh.title, MIN(e.last_snip_date) AS firstDate
       FROM shows sh JOIN episodes e ON e.show_id = sh.id
       WHERE e.last_snip_date IS NOT NULL AND EXISTS (SELECT 1 FROM snips s WHERE s.episode_id = e.id)
       GROUP BY sh.id`
    )
    .all() as unknown as { id: string; title: string; firstDate: string }[];
  const newShows = firstYearByShow
    .filter((s) => s.firstDate >= from && s.firstDate <= to && perShow.has(s.id))
    .map((s) => ({ id: s.id, title: s.title, episodes: perShow.get(s.id)?.episodes ?? 0 }))
    .sort((a, b) => b.episodes - a.episodes);

  // Comparison window: the same month last year, or the previous year.
  const prevRange = inMonth
    ? episodesInRange(db, `${year - 1}-${String(month).padStart(2, "0")}-01`, monthEnd(year - 1, month!))
    : episodesInRange(db, `${year - 1}-01-01`, `${year - 1}-12-31`);

  const tagRows = db
    .prepare(
      `SELECT t.key, t.label, COUNT(*) AS count
       FROM snip_tags st JOIN tags t ON t.id = st.tag_id
       JOIN snips s ON s.id = st.snip_id JOIN episodes e ON e.id = s.episode_id
       WHERE e.last_snip_date BETWEEN ? AND ?
       GROUP BY t.id ORDER BY count DESC LIMIT ?`
    )
    .all(from, to, LIST_CAP) as unknown as { key: string; label: string; count: number }[];

  const favoriteShows = db
    .prepare(
      `SELECT sh.id, sh.title, COUNT(*) AS favorites
       FROM snips s JOIN episodes e ON e.id = s.episode_id JOIN shows sh ON sh.id = e.show_id
       WHERE s.favorited = 1 AND e.last_snip_date BETWEEN ? AND ?
       GROUP BY sh.id ORDER BY favorites DESC LIMIT ?`
    )
    .all(from, to, LIST_CAP) as unknown as { id: string; title: string; favorites: number }[];

  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM snips s JOIN episodes e ON e.id = s.episode_id
           WHERE s.favorited = 1 AND e.last_snip_date BETWEEN ?1 AND ?2) AS favorites,
         (SELECT COUNT(*) FROM snips s JOIN episodes e ON e.id = s.episode_id
           WHERE s.quote_text IS NOT NULL AND e.last_snip_date BETWEEN ?1 AND ?2) AS quotes,
         (SELECT COUNT(DISTINCT eb.book_id) FROM episode_books eb JOIN episodes e ON e.id = eb.episode_id
           WHERE e.last_snip_date BETWEEN ?1 AND ?2) AS books,
         (SELECT COUNT(DISTINCT eg.guest_id) FROM episode_guests eg JOIN episodes e ON e.id = eg.episode_id
           WHERE e.last_snip_date BETWEEN ?1 AND ?2) AS guests`
    )
    .get(from, to) as { favorites: number; quotes: number; books: number; guests: number };

  const shows = [...perShow.values()];
  const activeDates = [...days.keys()];
  return {
    year,
    month: inMonth ? month! : null,
    episodes: episodes.length,
    snips: snips.length,
    shows: shows.length,
    estimatedSec: episodes.reduce((acc, e) => acc + (e.duration_sec ?? 0), 0),
    snipSec: snipSeconds(snips),
    activeDays: activeDates.length,
    quotes: counts.quotes,
    favorites: counts.favorites,
    topShows: shows.sort((a, b) => b.estimatedSec - a.estimatedSec),
    totalShows: shows.length,
    favoriteShows,
    biggestMonths: [...months.entries()]
      .map(([m, v]) => ({ month: m, episodes: v.episodes, snips: v.snips }))
      .sort((a, b) => b.episodes - a.episodes)
      .slice(0, LIST_CAP),
    longestEpisodes,
    mostSnippedEpisodes: mostSnipped,
    densestEpisodes,
    // Volume guard: one 3-minute episode with two snips shouldn't top a density
    // leaderboard, so a show needs a real body of listening to qualify.
    densityLeaders: shows
      .filter((s) => s.episodes >= DENSITY_MIN_EPISODES && s.estimatedSec >= DENSITY_MIN_SEC)
      .sort((a, b) => (b.snipsPerHour ?? 0) - (a.snipsPerHour ?? 0))
      .slice(0, LIST_CAP),
    newShows: newShows.slice(0, LIST_CAP),
    oneAndDone: shows.filter((s) => s.episodes === 1).map((s) => ({ id: s.id, title: s.title })).slice(0, LIST_CAP),
    busiestDays,
    longestStreak: computeStreaks(activeDates, to).best,
    months: [...Array(12)].map((_, i) => {
      const key = `${year}-${String(i + 1).padStart(2, "0")}`;
      const m = months.get(key) ?? { episodes: 0, snips: 0, estimatedSec: 0 };
      return { month: key, ...m };
    }),
    weekdays: weekdays.map((w, i) => ({ day: WEEKDAYS[i], ...w })),
    durationBuckets: buckets,
    topTags: tagRows,
    books: counts.books,
    guests: counts.guests,
    previous:
      prevRange.episodes.length > 0
        ? {
            year: year - 1,
            episodes: prevRange.episodes.length,
            snips: prevRange.snips.length,
            estimatedSec: prevRange.episodes.reduce((acc, e) => acc + (e.duration_sec ?? 0), 0),
          }
        : null,
  };
}
