export type Period = "week" | "month" | "year" | "all";

export interface Overview {
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

export interface ShowStatsRow {
  id: string;
  title: string;
  imageUrl: string | null;
  episodes: number;
  snips: number;
  estimatedSec: number;
  snipSec: number;
  snipsPerHour: number | null;
  snipsPerEpisode: number | null;
  avgEpisodeSec: number | null;
  lastActivity: string | null;
}

export interface ActivityBucket {
  date: string;
  episodes: number;
  snips: number;
  estimatedSec: number;
}

export interface CalendarDay {
  date: string;
  episodes: number;
  snips: number;
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

export interface Category {
  id: number;
  name: string;
  note: string | null;
  source: string;
  size: number;
  manual: number;
  shows: number;
  favorites: number;
}

export interface CategoriesStatus {
  categories: number;
  assigned: number;
  uncategorized: number;
  threshold: number;
  llm: { provider: "ollama"; url?: string; model?: string } | null;
}

export interface AskSource extends SearchHit {
  n: number;
  passage: string;
}

export interface AskAnswer {
  question: string;
  answer: string;
  mode: "extractive" | "llm";
  sources: AskSource[];
  llmError: string | null;
  tookMs: number;
}

export interface Wrapped {
  year: number;
  month: number | null;
  episodes: number;
  snips: number;
  shows: number;
  estimatedSec: number;
  snipSec: number;
  activeDays: number;
  quotes: number;
  favorites: number;
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
  topTags: TagCount[];
  books: number;
  guests: number;
  previous: { year: number; episodes: number; snips: number; estimatedSec: number } | null;
}

export interface TagCount {
  key: string;
  label: string;
  count: number;
}

export interface Tag {
  id: number;
  key: string;
  label: string;
  source: "snipd" | "user";
  snips: number;
  shows: number;
  episodes: number;
  favorites: number;
  firstDate: string | null;
  lastDate: string | null;
  live: number;
}

export interface TagSnip {
  id: string;
  title: string | null;
  quoteText: string | null;
  quoteAttribution: string | null;
  summaryMd: string | null;
  startSec: number | null;
  endSec: number | null;
  shareUrl: string | null;
  episodeId: string;
  episodeTitle: string;
  lastSnipDate: string | null;
  showId: string;
  showTitle: string;
  favorited: boolean;
  missingFromVault: boolean;
  tags: string[];
}

export interface ShowListItem {
  id: string;
  title: string;
  author: string | null;
  imageUrl: string | null;
  url: string | null;
  episodes: number;
  snips: number;
  lastActivity: string | null;
}

export interface EpisodeListItem {
  id: string;
  title: string;
  publishDate: string | null;
  lastSnipDate: string | null;
  durationSec: number | null;
  aiDescription: string | null;
  missingFromVault: 0 | 1;
  snips: number;
}

export interface ShowDetail extends Omit<ShowListItem, "episodes"> {
  episodes: EpisodeListItem[];
}

export interface Snip {
  id: string;
  ord: number;
  title: string | null;
  shareUrl: string | null;
  startSec: number | null;
  endSec: number | null;
  durationSec: number | null;
  summaryMd: string | null;
  quoteText: string | null;
  quoteAttribution: string | null;
  quoteCaption: string | null;
  transcriptMd: string | null;
  favorited: 0 | 1;
  tagsJson: string | null;
  missingFromVault: 0 | 1;
}

export interface EpisodeDetail {
  id: string;
  title: string;
  publishDate: string | null;
  lastSnipDate: string | null;
  durationSec: number | null;
  aiDescription: string | null;
  url: string | null;
  imageUrl: string | null;
  showId: string;
  showTitle: string;
  snips: Snip[];
  guests: { name: string; url: string | null }[];
  books: { title: string; author: string | null; url: string | null }[];
}

export interface RecentItem {
  id: string;
  title: string;
  lastSnipDate: string;
  showTitle: string;
  snips: number;
}

export interface Meta {
  version: string;
  vaultPath: string | null;
  totals: { shows: number; episodes: number; snips: number };
  lastSync: { at: string; parsed: number; unchanged: number; warnings: number } | null;
  syncing: boolean;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
  whatToTest: string[];
}

export type BookmarkType = "show" | "episode" | "snip";

export interface SearchHit {
  id: string;
  title: string | null;
  quoteText: string | null;
  quoteAttribution: string | null;
  summaryMd: string | null;
  transcriptSnippet: string | null;
  startSec: number | null;
  endSec: number | null;
  shareUrl: string | null;
  episodeId: string;
  episodeTitle: string;
  lastSnipDate: string | null;
  showId: string;
  showTitle: string;
  favorited: boolean;
  bookmarkSnip: boolean;
  bookmarkEpisode: boolean;
  bookmarkShow: boolean;
  missingFromVault: boolean;
  tags: string[];
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  tookMs: number;
  query: string;
  facets: TagCount[];
  /** What the server actually ran — "keyword" when vectors aren't built yet. */
  mode?: SearchMode;
  /** How many snips contain the words, in every mode, so counts stay comparable. */
  keywordTotal?: number;
  indexed?: number;
  indexTotal?: number;
}

export type SearchMode = "keyword" | "hybrid" | "semantic";

export interface RelatedSnip extends SearchHit {
  score: number;
}

export interface Topic {
  id: number;
  label: string;
  terms: string[];
  size: number;
  shows: number;
  favorites: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface MapPoint {
  id: string;
  x: number;
  y: number;
  /** Topic id, or -1 when unclustered. */
  c: number;
  /** 1 when the snip is a ⭐ Snipd favorite. */
  f: 0 | 1;
}

export interface TopicsStatus {
  clusters: number;
  placed: number;
  vectors: number;
  job: {
    running: boolean;
    phase: string | null;
    done: number;
    total: number;
    finishedAt: string | null;
    error: string | null;
  };
}

export type EmbedSpeed = "gentle" | "balanced" | "fast";

export interface EmbedStatus {
  embedded: number;
  total: number;
  pending: number;
  model: string;
  job: {
    running: boolean;
    done: number;
    total: number;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
    speed?: EmbedSpeed;
  };
}

export interface TimelineEntry {
  kind: "favorite" | "bookmark";
  type: BookmarkType;
  id: string;
  date: string | null;
  startSec: number | null;
  title: string;
  subtitle: string;
  showTitle: string | null;
  episodeTitle: string | null;
  quoteText: string | null;
  summaryMd: string | null;
  episodeId: string | null;
  showId: string | null;
  shareUrl: string | null;
  starredAt: string | null;
  missingFromVault: boolean;
  tags: string[];
}

export interface SavedSearch {
  id: number;
  name: string;
  query: { q: string; filters: Record<string, unknown> };
  createdAt: string;
  lastSeenAt: string | null;
  newCount: number;
}

export interface Book {
  id: string;
  title: string;
  author: string | null;
  url: string | null;
  mentions: number;
  shows: number;
  lastMention: string | null;
}

export interface Person {
  id: string;
  name: string;
  url: string | null;
  episodes: number;
  shows: number;
  lastSeen: string | null;
}

export interface MentionEpisode {
  id: string;
  title: string;
  lastSnipDate: string | null;
  showTitle: string;
}

export interface PackPlannedFile {
  name: string;
  group: string;
  part: number;
  parts: number;
  snips: number;
  words: number;
}
export interface PackPlan {
  files: PackPlannedFile[];
  totalSnips: number;
  totalWords: number;
  fits: { free: boolean; pro: boolean; ultra: boolean };
  notes: string[];
  options: { group: string; include: string; maxWords: number; scope: string };
}
export interface PackResult {
  dir: string;
  sourcesDir: string;
  files: PackPlannedFile[];
  totalWords: number;
  totalSnips: number;
}

/**
 * Every page fetches with `api(...).then(setState)`. If the server stops
 * answering — it was closed, the machine slept, its console window was clicked
 * into "Select" mode — those promises never settle, so the page sits there
 * blank and the app looks like it lost your library. A request that cannot be
 * answered has to fail, and something has to say so out loud.
 */
const REQUEST_TIMEOUT_MS = 20_000;
/** Restores, index builds and model answers are slow on purpose. */
export const LONG_TIMEOUT_MS = 5 * 60_000;

type ReachabilityListener = (reachable: boolean) => void;
const reachabilityListeners = new Set<ReachabilityListener>();
let serverReachable = true;

/** Subscribe to "the server stopped answering" / "it's back". */
export function onServerReachability(fn: ReachabilityListener): () => void {
  reachabilityListeners.add(fn);
  return () => {
    reachabilityListeners.delete(fn);
  };
}

function setReachable(next: boolean) {
  if (next === serverReachable) return;
  serverReachable = next;
  for (const fn of reachabilityListeners) fn(next);
}

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

/**
 * The one place that talks to the server. A response of any status — even 500 —
 * means it is alive; only a network-level failure or a timeout means it isn't.
 */
export async function request(path: string, opts: RequestOptions = {}): Promise<Response> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...init } = opts;
  try {
    const res = await fetch(path, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    setReachable(true);
    return res;
  } catch (err) {
    setReachable(false);
    throw err;
  }
}

/**
 * The server explains its refusals — "That folder doesn't exist", "Couldn't
 * find a Snipd Data folder inside that path" — and those two mean opposite
 * things to whoever typed the path. Throwing away the body and reporting the
 * status code loses exactly the part worth reading.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function refusal(path: string, res: Response): Promise<ApiError> {
  let said = "";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string") said = body.error;
  } catch {
    /* not JSON; the status is all there is */
  }
  return new ApiError(res.status, said || `${path} → ${res.status}`);
}

export async function postJson<T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
  const res = await request(path, {
    ...opts,
    method: "POST",
    headers: { "Content-Type": "application/json", ...opts.headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await refusal(path, res);
  return res.json() as Promise<T>;
}

export async function del(path: string): Promise<void> {
  await request(path, { method: "DELETE" });
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(path, opts);
  if (!res.ok) throw await refusal(path, res);
  return res.json() as Promise<T>;
}

export async function postSync(full = false) {
  const res = await request(`/api/sync${full ? "?full=1" : ""}`, {
    method: "POST",
    timeoutMs: LONG_TIMEOUT_MS,
  });
  return res.json();
}
