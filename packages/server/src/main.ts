import type { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  DATA_DIR,
  DB_PATH,
  EMBED_SPEEDS,
  planPack,
  writePack,
  WORDS_PER_SOURCE,
  ask,
  DatabaseBusyError,
  backupStatus,
  createSnapshot,
  createWorkBackup,
  restoreSnapshot,
  checkpoint,
  healthCheck,
  reviewQueue,
  recordReview,
  reviewStats,
  onThisDay,
  serendipity,
  weeklyDigest,
  digestRss,
  type ReviewAction,
  probeOllama,
  kindStats,
  unsureSnips,
  setSnipKind,
  assignCategories,
  bookEpisodes,
  categoriesStatus,
  categorySnips,
  createCategory,
  deleteCategory,
  bookmarksTimeline,
  createSavedSearch,
  deleteSavedSearch,
  detectVaults,
  embedStatus,
  favoritesToMarkdown,
  getActivity,
  getCalendar,
  getEpisode,
  getOverview,
  getRecent,
  getShow,
  getShowStats,
  getWrapped,
  hybridSearch,
  hydrateSnips,
  snipDetail,
  importVault,
  invalidateMatrix,
  listTopics,
  mapPoints,
  mergeCategories,
  listBooks,
  listBookmarks,
  listPeople,
  listCategories,
  listSavedSearches,
  listShows,
  listTags,
  loadConfig,
  localEmbedder,
  openDb,
  periodRange,
  personEpisodes,
  relatedSnips,
  renameCategory,
  saveConfig,
  seedCategoriesFromTopics,
  setCategorySnip,
  snipCategories,
  searchHitsToCsv,
  searchHitsToMarkdown,
  searchSnips,
  semanticSearch,
  setBookmark,
  snipdFavoritesTimeline,
  tagFacets,
  tagSnips,
  tagToMarkdown,
  topTags,
  topicSnips,
  topicsStatus,
  touchSavedSearch,
  type BookmarkType,
  type EmbedSpeed,
  type Embedder,
  type Period,
  type SearchFilters,
} from "@resurface/core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WEB_DIST = join(ROOT, "packages", "web", "dist");
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const PORT = Number(process.env.RESURFACE_PORT ?? 7433);
const HOST = process.env.RESURFACE_HOST ?? "127.0.0.1";

function resolveVault(): string | null {
  const cfg = loadConfig();
  if (cfg.vaultPath && existsSync(cfg.vaultPath)) return cfg.vaultPath;
  // Auto-adopt only an unambiguous single detection; otherwise the web UI
  // shows the first-run setup screen and asks.
  const { candidates } = detectVaults();
  if (candidates.length === 1) {
    saveConfig({ ...cfg, vaultPath: candidates[0] });
    return candidates[0];
  }
  return null;
}

// A second copy of the app must not open the database — see openDb's lock.
let db: DatabaseSync;
try {
  db = openDb(DB_PATH);
} catch (err) {
  if (err instanceof DatabaseBusyError) {
    console.error(`\n[resurface] ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
let vaultPath = resolveVault();
let lastSync: { at: string; parsed: number; unchanged: number; warnings: number } | null = null;
let syncing = false;

function runSync(force = false) {
  if (!vaultPath || syncing) return null;
  syncing = true;
  try {
    const report = importVault(db, vaultPath, { force });
    lastSync = {
      at: report.finishedAt,
      parsed: report.filesParsed,
      unchanged: report.filesUnchanged,
      warnings: report.warnings.length,
    };
    return report;
  } finally {
    syncing = false;
  }
}

/**
 * Backups, on a timer.
 *
 * The review history exists nowhere but this file — the vault cannot rebuild
 * it — so upkeep runs unattended rather than waiting to be asked. The cheap
 * JSON of irreplaceable rows is written at every opportunity; the full
 * snapshot, which costs a few seconds and a few hundred megabytes, is taken
 * once a day.
 */
const backupJob = { lastError: null as string | null, lastSnapshotAt: null as string | null, running: false };

/**
 * Corruption watch.
 *
 * Concurrent access could not be made to corrupt this database in testing, so
 * the cause of the damage seen earlier is not established. Rather than claim a
 * fix, the app checks itself regularly and says so loudly the moment a page
 * goes bad — while a verified backup from hours ago is still sitting there.
 */
let lastHealth: ReturnType<typeof healthCheck> | null = null;

function runHealthCheck() {
  lastHealth = healthCheck(db, DB_PATH);
  if (!lastHealth.ok) {
    console.error(
      `\n[resurface] DATABASE PROBLEM: ${lastHealth.detail}\n` +
        (lastHealth.suggestedBackup
          ? `[resurface] Restore ${lastHealth.suggestedBackup} from the dashboard's Backups panel.\n`
          : "[resurface] No verified snapshot is available to restore.\n")
    );
  }
  return lastHealth;
}

function maybeBackup(reason: string) {
  if (backupJob.running) return;
  backupJob.running = true;
  try {
    const cfg = loadConfig();
    createWorkBackup(db, DB_PATH);
    const status = backupStatus(DB_PATH);
    const everyMs = (cfg.backupEveryHours ?? 24) * 3600_000;
    const due = !status.lastSnapshotAt || Date.now() - Date.parse(status.lastSnapshotAt) >= everyMs;
    if (due) {
      const { info } = createSnapshot(db, DB_PATH, { keep: cfg.backupKeep ?? 3 });
      backupJob.lastSnapshotAt = info.createdAt;
      console.log(`[resurface] backup (${reason}): ${info.file}`);
    }
    backupJob.lastError = null;
  } catch (err) {
    // A failed backup must never take the app down, but it must be visible.
    backupJob.lastError = (err as Error).message;
    console.error("[resurface] backup failed:", backupJob.lastError);
  } finally {
    backupJob.running = false;
  }
}

/**
 * Embedding job: one at a time, resumable, in-process. The model itself is
 * ~25 MB downloaded once into %LOCALAPPDATA%\Resurface\models; nothing leaves
 * this machine.
 */
const MODEL_DIR = join(dirname(DB_PATH), "models");
const embedJob = {
  running: false,
  done: 0,
  total: 0,
  startedAt: null as string | null,
  finishedAt: null as string | null,
  error: null as string | null,
  speed: (loadConfig().embedSpeed ?? "gentle") as EmbedSpeed,
};
let embedWorker: Worker | null = null;
let queryWorker: Worker | null = null;
let queryReady: Promise<Embedder> | null = null;
let querySeq = 0;
const queryWaiters = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();

/**
 * Query-side embedder, also in a worker: the main thread never loads ONNX, so
 * a search can't stall the server and can't collide with the build worker.
 */
function getEmbedder(): Promise<Embedder> {
  if (queryReady) return queryReady;
  queryReady = new Promise<Embedder>((resolve, reject) => {
    const w = new Worker(new URL("./query-worker.ts", import.meta.url), {
      workerData: { modelDir: MODEL_DIR },
      execArgv: ["--import", "tsx"],
    });
    queryWorker = w;
    w.on("message", (msg: { type?: string; id?: number; vectors?: number[][]; error?: string }) => {
      if (msg.type === "ready") {
        resolve(async (texts) => {
          const id = ++querySeq;
          return new Promise<Float32Array[]>((res, rej) => {
            queryWaiters.set(id, { resolve: res, reject: rej });
            w.postMessage({ id, texts });
          });
        });
        return;
      }
      const waiter = msg.id !== undefined ? queryWaiters.get(msg.id) : undefined;
      if (!waiter) return;
      queryWaiters.delete(msg.id!);
      if (msg.error) waiter.reject(new Error(msg.error));
      else waiter.resolve((msg.vectors ?? []).map((v) => Float32Array.from(v)));
    });
    w.on("error", (err) => {
      queryReady = null;
      queryWorker = null;
      for (const [, waiter] of queryWaiters) waiter.reject(err);
      queryWaiters.clear();
      reject(err);
    });
    w.on("exit", () => {
      queryReady = null;
      queryWorker = null;
    });
  });
  return queryReady;
}

/**
 * Windows scheduling: a full-tilt build makes the whole desktop feel sluggish,
 * so the process drops to below-normal priority while it runs and goes back to
 * normal afterwards. Cheap, reversible, and invisible to HTTP work.
 */
function setPriority(level: number) {
  try {
    os.setPriority(process.pid, level);
  } catch {
    // Not permitted on some systems — throttling still applies.
  }
}

/**
 * Keep the meaning index level with the library.
 *
 * Every sync brings in new snips, and nothing was ever embedding them: the only
 * caller of startEmbedJob was the button. So the index sat at whatever it
 * reached the last time someone pressed it and fell further behind with each
 * sync — 32,196 vectors against 33,402 snips, unchanged for days — until the
 * dashboard's "Resume (1,206 left)" was noticed and read as the index having
 * emptied itself. Nothing was lost; nothing was being added.
 *
 * Topping up is cheap: those 1,206 took 82 seconds. A *first* build is not — 45
 * minutes for 30k snips, plus a model download — so that stays a deliberate
 * press, and this only ever finishes what has already been started.
 */
function topUpEmbeddings(reason: string) {
  if (embedJob.running || topicsJob.running) return;
  const { embedded, pending } = embedStatus(db);
  if (embedded === 0 || pending === 0) return;
  console.log(`[resurface] embedding ${pending.toLocaleString()} new snips (${reason})`);
  startEmbedJob(loadConfig().embedSpeed ?? embedJob.speed);
}

function startEmbedJob(speed: EmbedSpeed) {
  if (embedWorker) return;
  const profile = EMBED_SPEEDS[speed] ?? EMBED_SPEEDS.gentle;
  Object.assign(embedJob, {
    running: true,
    done: 0,
    total: embedStatus(db).pending,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    speed,
  });
  setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  embedWorker = new Worker(new URL("./embed-worker.ts", import.meta.url), {
    workerData: { dbPath: DB_PATH, modelDir: MODEL_DIR, threads: profile.threads, pauseMs: profile.pauseMs },
    execArgv: ["--import", "tsx"],
    resourceLimits: { maxOldGenerationSizeMb: 1024 },
  });
  embedWorker.on("message", (msg: { type: string; done?: number; total?: number; message?: string }) => {
    if (msg.type === "progress") {
      embedJob.done = msg.done ?? 0;
      embedJob.total = msg.total ?? embedJob.total;
      invalidateMatrix(); // vectors written by the worker are new to this process
    } else if (msg.type === "error") {
      embedJob.error = msg.message ?? "unknown error";
    }
  });
  embedWorker.on("error", (err) => {
    embedJob.error = err.message;
    console.error("[resurface] embedding worker failed:", err);
  });
  embedWorker.on("exit", () => {
    embedWorker = null;
    embedJob.running = false;
    embedJob.finishedAt = new Date().toISOString();
    setPriority(os.constants.priority.PRIORITY_NORMAL);
    invalidateMatrix();
    console.log(`[resurface] embedding stopped: ${embedStatus(db).embedded} vectors stored`);
  });
}

const topicsJob = {
  running: false,
  phase: null as string | null,
  done: 0,
  total: 0,
  finishedAt: null as string | null,
  error: null as string | null,
};
let topicsWorker: Worker | null = null;

function startTopicsJob(k?: number) {
  if (topicsWorker) return;
  Object.assign(topicsJob, { running: true, phase: "starting", done: 0, total: 1, finishedAt: null, error: null });
  setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  topicsWorker = new Worker(new URL("./topics-worker.ts", import.meta.url), {
    workerData: { dbPath: DB_PATH, k },
    execArgv: ["--import", "tsx"],
  });
  topicsWorker.on("message", (msg: { type: string; phase?: string; done?: number; total?: number; message?: string }) => {
    if (msg.type === "progress") {
      topicsJob.phase = msg.phase ?? null;
      topicsJob.done = msg.done ?? 0;
      topicsJob.total = msg.total ?? 1;
    } else if (msg.type === "error") topicsJob.error = msg.message ?? "unknown error";
  });
  topicsWorker.on("error", (err) => {
    topicsJob.error = err.message;
    console.error("[resurface] topics worker failed:", err);
  });
  topicsWorker.on("exit", () => {
    topicsWorker = null;
    topicsJob.running = false;
    topicsJob.phase = null;
    topicsJob.finishedAt = new Date().toISOString();
    if (!embedJob.running) setPriority(os.constants.priority.PRIORITY_NORMAL);
    const s = topicsStatus(db);
    console.log(`[resurface] topics: ${s.clusters} clusters over ${s.placed} snips`);
  });
}

const app = new Hono();

const period = (c: { req: { query: (k: string) => string | undefined } }): Period => {
  const p = c.req.query("period");
  return p === "week" || p === "month" || p === "year" || p === "all" ? p : "month";
};

app.get("/api/meta", (c) => {
  const totals = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM shows) AS shows,
              (SELECT COUNT(*) FROM episodes WHERE archived = 0) AS episodes,
              (SELECT COUNT(*) FROM snips WHERE archived = 0) AS snips`
    )
    .get();
  return c.json({ version: VERSION, vaultPath, dbPath: DB_PATH, totals, lastSync, syncing });
});

app.get("/api/changelog", (c) => {
  try {
    return c.json(JSON.parse(readFileSync(join(ROOT, "CHANGELOG.json"), "utf8")));
  } catch {
    return c.json([]);
  }
});

app.get("/api/stats/overview", (c) => c.json(getOverview(db, period(c))));
app.get("/api/stats/shows", (c) => c.json(getShowStats(db, period(c))));
app.get("/api/stats/activity", (c) => {
  const bucket = c.req.query("bucket") === "week" ? "week" : "day";
  return c.json(getActivity(db, period(c), bucket));
});
const thisYear = () => new Date().getFullYear();
app.get("/api/stats/calendar", (c) =>
  c.json(getCalendar(db, clampNum(c.req.query("year"), thisYear(), 1970, 9999)))
);
app.get("/api/stats/wrapped", (c) => {
  // An out-of-range month used to be ignored, quietly answering with the whole
  // year — a wrong answer presented as a right one.
  const rawMonth = c.req.query("month");
  if (rawMonth !== undefined && rawMonth !== "") {
    const m = Number(rawMonth);
    if (!Number.isInteger(m) || m < 1 || m > 12)
      return c.json({ error: "month must be a whole number from 1 to 12" }, 400);
  }
  return c.json(
    getWrapped(db, clampNum(c.req.query("year"), thisYear(), 1970, 9999), rawMonth ? Number(rawMonth) : null)
  );
});

app.get("/api/shows", (c) => c.json(listShows(db)));
app.get("/api/shows/:id", (c) => {
  const show = getShow(db, c.req.param("id"));
  return show ? c.json(show) : c.json({ error: "not found" }, 404);
});
app.get("/api/episodes/:id", (c) => {
  const ep = getEpisode(db, c.req.param("id"));
  return ep ? c.json(ep) : c.json({ error: "not found" }, 404);
});
app.get("/api/recent", (c) => c.json(getRecent(db, clampNum(c.req.query("limit"), 12, 1, 100))));

/**
 * Query numbers arrive as text and cannot be trusted. Unclamped, `limit=-5`
 * and `limit=999999` both had the same effect: every snip in the library
 * serialised into one response.
 */
function clampNum(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** The most rows any single request will serialise. */
const MAX_PAGE = 500;

const filtersFrom = (q: (k: string) => string | undefined): SearchFilters => ({
  show: q("show") || undefined,
  from: q("from") || undefined,
  to: q("to") || undefined,
  starredOnly: q("starred") === "1" || q("favorites") === "1",
  hasQuote: q("hasQuote") === "1",
  tags: (q("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
  tagMode: q("tagMode") === "all" ? "all" : "any",
  kind: q("kind") === "auto" || q("kind") === "manual" ? (q("kind") as "auto" | "manual") : undefined,
  sort: (q("sort") as SearchFilters["sort"]) ?? "relevance",
  limit: clampNum(q("limit"), 25, 1, MAX_PAGE),
  offset: clampNum(q("offset"), 0, 0, 1_000_000),
});

app.get("/api/search", async (c) => {
  const q = c.req.query("q") ?? "";
  const filters = filtersFrom((k) => c.req.query(k));
  const mode = c.req.query("mode") ?? "keyword";
  const facets = c.req.query("facets") === "0" ? [] : tagFacets(db, q, filters);
  // Smart modes need vectors. A partial index still works — it just searches
  // the part that's built — so only a completely empty index falls back.
  const status = embedStatus(db);
  if (mode !== "keyword" && status.embedded > 0 && q.trim()) {
    try {
      const embedder = await getEmbedder();
      const result =
        mode === "semantic"
          ? await semanticSearch(db, q, embedder, filters, filters.limit ?? 25)
          : await hybridSearch(db, q, embedder, filters);
      // Keyword total travels with every mode so the counts stay comparable.
      const keywordTotal =
        "keywordTotal" in result ? result.keywordTotal : searchSnips(db, q, { ...filters, limit: 1 }).total;
      return c.json({ ...result, keywordTotal, facets, mode, indexed: status.embedded, indexTotal: status.total });
    } catch (err) {
      console.error("[resurface] smart search failed, falling back to keyword:", err);
    }
  }
  const keyword = searchSnips(db, q, filters);
  return c.json({
    ...keyword,
    keywordTotal: keyword.total,
    facets,
    mode: "keyword",
    indexed: status.embedded,
    indexTotal: status.total,
  });
});

// Full snip rows by id — the map hydrates a point on hover.
app.get("/api/snips/:id/hydrate", (c) => c.json(hydrateSnips(db, [c.req.param("id")])));
/** Full snip including transcript — fetched only when a reader expands one. */
app.get("/api/snips/:id/full", (c) => {
  const s = snipDetail(db, c.req.param("id"));
  return s ? c.json(s) : c.json({ error: "not found" }, 404);
});

// Related snips need no model — the snip's vector is already stored.
app.get("/api/snips/:id/related", (c) =>
  c.json(relatedSnips(db, c.req.param("id"), clampNum(c.req.query("k"), 6, 1, 50)))
);

app.get("/api/categories", (c) => c.json(listCategories(db)));
app.get("/api/categories/status", (c) => c.json({ ...categoriesStatus(db), llm: loadConfig().llm ?? null }));
app.post("/api/categories", async (c) => {
  const body = (await c.req.json()) as { name?: string; note?: string };
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  return c.json({ id: createCategory(db, body.name, body.note) });
});
app.post("/api/categories/seed", (c) => {
  if (topicsStatus(db).clusters === 0) return c.json({ error: "find topics first" }, 409);
  return c.json(seedCategoriesFromTopics(db));
});
app.post("/api/categories/assign", (c) => {
  const threshold = c.req.query("threshold")
    ? clampNum(c.req.query("threshold"), 0.42, 0, 1)
    : loadConfig().categoryThreshold;
  if (threshold !== undefined) saveConfig({ ...loadConfig(), categoryThreshold: threshold });
  return c.json(assignCategories(db, { threshold }));
});
app.patch("/api/categories/:id", async (c) => {
  const body = (await c.req.json()) as { name?: string; note?: string | null; mergeInto?: number };
  const id = Number(c.req.param("id"));
  if (body.mergeInto !== undefined) mergeCategories(db, id, body.mergeInto);
  else if (body.name) renameCategory(db, id, body.name, body.note ?? null);
  return c.json({ ok: true });
});
app.delete("/api/categories/:id", (c) => {
  deleteCategory(db, Number(c.req.param("id")));
  return c.json({ ok: true });
});
app.get("/api/categories/:id/snips", (c) => {
  const { ids, total } = categorySnips(db, Number(c.req.param("id")), {
    limit: clampNum(c.req.query("limit"), 25, 1, MAX_PAGE),
    offset: clampNum(c.req.query("offset"), 0, 0, 1_000_000),
  });
  return c.json({ snips: hydrateSnips(db, ids), total });
});
app.post("/api/categories/:id/snips", async (c) => {
  const body = (await c.req.json()) as { snipId: string; member: boolean };
  setCategorySnip(db, Number(c.req.param("id")), body.snipId, body.member !== false);
  return c.json({ ok: true });
});
app.get("/api/snips/:id/categories", (c) => c.json(snipCategories(db, c.req.param("id"))));

app.post("/api/ask", async (c) => {
  const body = (await c.req.json()) as { question?: string; show?: string; useLlm?: boolean };
  const question = (body.question ?? "").trim();
  if (!question) return c.json({ error: "question required" }, 400);
  if (embedStatus(db).embedded === 0)
    return c.json({ error: "Build the meaning index first — Ask needs it to find relevant snips." }, 409);
  const cfg = loadConfig();
  const embedder = await getEmbedder();
  return c.json(
    await ask(db, question, embedder, { llm: body.useLlm === false ? null : cfg.llm ?? null, show: body.show })
  );
});
/** Current setting plus a live check, so the page can tell the truth on load. */
app.get("/api/settings/llm", async (c) => {
  const llm = loadConfig().llm ?? null;
  if (!llm) return c.json({ llm: null, probe: null });
  return c.json({ llm, probe: await probeOllama(llm) });
});
/** Probe without saving — powers "Test connection" and the pre-save check. */
app.post("/api/settings/llm/probe", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: string; model?: string };
  return c.json(await probeOllama(body));
});
app.post("/api/settings/llm", async (c) => {
  const body = (await c.req.json()) as { llm: { provider: "ollama"; url?: string; model?: string } | null };
  // Disconnecting always works; connecting has to prove itself first, so the
  // app can never sit in a "connected but broken" state.
  if (body.llm === null) {
    saveConfig({ ...loadConfig(), llm: null });
    return c.json({ ok: true, llm: null, probe: null });
  }
  const probe = await probeOllama(body.llm);
  if (!probe.ok) return c.json({ ok: false, llm: null, probe }, 400);
  saveConfig({ ...loadConfig(), llm: body.llm });
  return c.json({ ok: true, llm: body.llm, probe });
});

/** Today's review batch — deterministic per day, so a reload doesn't reshuffle. */
app.get("/api/review", (c) => {
  const cfg = loadConfig();
  return c.json({
    cards: reviewQueue(db, {
      size: clampNum(c.req.query("size"), cfg.reviewSize ?? 5, 1, 50),
      manualQuota: clampNum(c.req.query("manualQuota"), cfg.reviewManualQuota ?? 3, 0, 50),
    }),
    stats: reviewStats(db),
  });
});
app.post("/api/review/:id", async (c) => {
  const body = (await c.req.json()) as { action?: ReviewAction };
  const allowed: ReviewAction[] = ["keep", "more", "less", "mute"];
  if (!body.action || !allowed.includes(body.action))
    return c.json({ error: `action must be one of ${allowed.join(", ")}` }, 400);
  const id = c.req.param("id");
  // Reviewing a snip that isn't here is a 404, not a foreign-key crash.
  const exists = db.prepare("SELECT 1 FROM snips WHERE id = ?").get(id);
  if (!exists) return c.json({ error: "no such snip" }, 404);
  return c.json(recordReview(db, id, body.action));
});
app.post("/api/settings/review", async (c) => {
  const body = (await c.req.json()) as { size?: number; manualQuota?: number };
  const size = Math.max(1, Math.min(20, body.size ?? 5));
  saveConfig({
    ...loadConfig(),
    reviewSize: size,
    reviewManualQuota: Math.max(0, Math.min(size, body.manualQuota ?? 3)),
  });
  return c.json({ ok: true });
});

app.get("/api/health", (c) => c.json(lastHealth ?? runHealthCheck()));
app.get("/api/backups", (c) => c.json({ ...backupStatus(DB_PATH), job: backupJob, health: lastHealth }));
app.post("/api/backups", async (c) => {
  const kind = (await c.req.json().catch(() => ({}))) as { kind?: "snapshot" | "work" };
  try {
    if (kind.kind === "work") return c.json({ ok: true, info: createWorkBackup(db, DB_PATH) });
    const { info, verify } = createSnapshot(db, DB_PATH, { keep: loadConfig().backupKeep ?? 3 });
    return c.json({ ok: true, info, verify });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});
/**
 * Restoring swaps the file underneath us, so the one connection is closed for
 * the duration and reopened afterwards. Refused while a background job holds
 * the database, since a worker would be writing into the file being replaced.
 */
app.post("/api/backups/restore", async (c) => {
  const body = (await c.req.json()) as { file?: string };
  if (!body.file) return c.json({ error: "file required" }, 400);
  if (embedJob.running || topicsJob.running)
    return c.json({ error: "A background job is running — stop it first, then restore." }, 409);
  db.close();
  try {
    const result = restoreSnapshot(DB_PATH, body.file);
    db = openDb(DB_PATH);
    invalidateMatrix();
    return c.json({ ok: true, ...result });
  } catch (err) {
    db = openDb(DB_PATH); // whatever is on disk, get back to serving
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.get("/api/on-this-day", (c) => c.json(onThisDay(db)));
app.get("/api/serendipity", (c) => c.json(serendipity(db) ?? null));
app.get("/api/digest", (c) => c.json(weeklyDigest(db, { today: c.req.query("week") || undefined })));
/** Pull, not push: a feed needs no account and no SMTP. */
app.get("/api/digest.xml", (c) => {
  const base = `http://${HOST}:${PORT}`;
  return new Response(digestRss(db, base, { weeks: 8 }), {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
});

app.get("/api/snips/kinds", (c) => c.json(kindStats(db)));
/** The classifier's least-certain calls, for a human to settle. */
app.get("/api/snips/kinds/unsure", (c) =>
  c.json(unsureSnips(db, clampNum(c.req.query("limit"), 100, 1, MAX_PAGE)))
);
app.post("/api/snips/:id/kind", async (c) => {
  const body = (await c.req.json()) as { kind: "auto" | "manual" | null };
  if (body.kind !== null && body.kind !== "auto" && body.kind !== "manual")
    return c.json({ error: "kind must be auto, manual or null" }, 400);
  const id = c.req.param("id");
  // Reporting success for a snip that isn't here would be a lie: the UPDATE
  // simply matches nothing.
  if (!db.prepare("SELECT 1 FROM snips WHERE id = ?").get(id)) return c.json({ error: "no such snip" }, 404);
  setSnipKind(db, id, body.kind);
  return c.json({ ok: true });
});

app.get("/api/topics", (c) => c.json(listTopics(db)));
app.get("/api/topics/status", (c) => c.json({ ...topicsStatus(db), job: topicsJob }));
app.post("/api/topics/build", (c) => {
  if (topicsJob.running) return c.json({ error: "already running" }, 409);
  if (topicsStatus(db).vectors === 0) return c.json({ error: "build the meaning index first" }, 409);
  startTopicsJob(c.req.query("k") ? clampNum(c.req.query("k"), 20, 2, 200) : undefined);
  return c.json({ started: true });
});
app.get("/api/topics/:id/snips", (c) => {
  const { ids, total } = topicSnips(db, Number(c.req.param("id")), {
    limit: clampNum(c.req.query("limit"), 25, 1, MAX_PAGE),
    offset: clampNum(c.req.query("offset"), 0, 0, 1_000_000),
  });
  return c.json({ snips: hydrateSnips(db, ids), total });
});
app.get("/api/map", (c) => c.json(mapPoints(db, { show: c.req.query("show") || undefined })));

app.get("/api/embeddings/status", (c) =>
  c.json({ ...embedStatus(db), job: embedJob, speeds: EMBED_SPEEDS })
);
app.post("/api/embeddings/build", (c) => {
  if (embedJob.running) return c.json({ error: "already running" }, 409);
  const requested = c.req.query("speed") as EmbedSpeed | undefined;
  const speed = requested && requested in EMBED_SPEEDS ? requested : embedJob.speed;
  saveConfig({ ...loadConfig(), embedSpeed: speed }); // remembered for next time
  startEmbedJob(speed);
  return c.json({ started: true, speed });
});
app.post("/api/embeddings/stop", (c) => {
  // Progress is already committed batch by batch, so stopping loses nothing.
  const worker = embedWorker;
  worker?.postMessage("stop");
  // A batch can take a few seconds; if the worker hasn't wound down by then,
  // stop meaning stop.
  setTimeout(() => {
    if (embedWorker === worker) void worker?.terminate();
  }, 15_000);
  return c.json({ ok: true });
});

app.get("/api/tags", (c) =>
  c.json(listTags(db, { includeRetired: c.req.query("retired") === "1" }))
);
app.get("/api/tags/:key/snips", (c) =>
  c.json(
    tagSnips(db, c.req.param("key"), {
      order: c.req.query("order") === "asc" ? "asc" : "desc",
      limit: clampNum(c.req.query("limit"), 50, 1, MAX_PAGE),
      offset: clampNum(c.req.query("offset"), 0, 0, 1_000_000),
    })
  )
);
app.get("/api/stats/tags", (c) => {
  const { from, to } = periodRange(period(c));
  return c.json(topTags(db, { from, to, limit: clampNum(c.req.query("limit"), 8, 1, 200) }));
});

app.get("/api/bookmarks", (c) => c.json(listBookmarks(db)));
app.post("/api/bookmarks", async (c) => {
  const body = (await c.req.json()) as { type: BookmarkType; id: string; on: boolean };
  if (!["show", "episode", "snip"].includes(body.type) || typeof body.id !== "string")
    return c.json({ error: "bad request" }, 400);
  setBookmark(db, body.type, body.id, body.on !== false);
  return c.json({ ok: true });
});
app.get("/api/bookmarks/timeline", (c) =>
  c.json(
    bookmarksTimeline(db, {
      type: (c.req.query("type") as BookmarkType) || undefined,
      show: c.req.query("show") || undefined,
      order: c.req.query("order") === "asc" ? "asc" : "desc",
    })
  )
);
app.get("/api/favorites/timeline", (c) =>
  c.json(
    snipdFavoritesTimeline(db, {
      show: c.req.query("show") || undefined,
      order: c.req.query("order") === "asc" ? "asc" : "desc",
    })
  )
);

app.get("/api/setup/detect", (c) => c.json(detectVaults()));
app.post("/api/setup", async (c) => {
  const body = (await c.req.json()) as { vaultPath?: string };
  let p = (body.vaultPath ?? "").trim().replace(/^["']|["']$/g, "");
  if (!p || !existsSync(p)) return c.json({ error: "That folder doesn't exist." }, 400);
  // Accept the Data folder itself, or any ancestor (vault root / Snipd folder).
  for (const suffix of [join("Snipd", "Data"), "Data"]) {
    const candidate = join(p, suffix);
    if (existsSync(candidate)) {
      p = candidate;
      break;
    }
  }
  if (!/\bData$/i.test(p) && !existsSync(join(p, "Data")))
    return c.json({ error: "Couldn't find a Snipd Data folder inside that path." }, 400);
  saveConfig({ ...loadConfig(), vaultPath: p });
  vaultPath = p;
  const report = runSync();
  return c.json({
    vaultPath: p,
    imported: report
      ? { filesParsed: report.filesParsed, snipsNew: report.snipsNew, totals: report.totals }
      : null,
  });
});

app.get("/api/saved-searches", (c) => c.json(listSavedSearches(db)));
app.post("/api/saved-searches", async (c) => {
  const body = (await c.req.json()) as { name: string; q: string; filters: SearchFilters };
  return c.json({ id: createSavedSearch(db, body.name, body.q, body.filters ?? {}) });
});
app.post("/api/saved-searches/:id/seen", (c) => {
  touchSavedSearch(db, Number(c.req.param("id")));
  return c.json({ ok: true });
});
app.delete("/api/saved-searches/:id", (c) => {
  deleteSavedSearch(db, Number(c.req.param("id")));
  return c.json({ ok: true });
});

app.get("/api/books", (c) => c.json(listBooks(db)));
app.get("/api/books/:id/episodes", (c) => c.json(bookEpisodes(db, c.req.param("id"))));
app.get("/api/people", (c) => c.json(listPeople(db)));
app.get("/api/people/:id/episodes", (c) => c.json(personEpisodes(db, c.req.param("id"))));

app.get("/api/export/favorites", (c) => {
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="favorites.md"');
  return c.body(favoritesToMarkdown(db));
});
app.get("/api/export/tag/:key", (c) => {
  const key = c.req.param("key");
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="tag-${key.replace(/[^\w-]+/g, "-")}.md"`);
  return c.body(tagToMarkdown(db, key));
});
app.get("/api/export/search", (c) => {
  const q = c.req.query("q") ?? "";
  const format = c.req.query("format") ?? "md";
  const result = searchSnips(db, q, { ...filtersFrom((k) => c.req.query(k)), limit: 1000, offset: 0 });
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="search-${stamp}.csv"`);
    return c.body(searchHitsToCsv(result.hits));
  }
  if (format === "json") {
    c.header("Content-Disposition", `attachment; filename="search-${stamp}.json"`);
    return c.json(result.hits);
  }
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="search-${stamp}.md"`);
  return c.body(searchHitsToMarkdown(result.hits, q));
});

/**
 * NotebookLM has no API for the consumer product, so this cannot push anything
 * into it. What it can do is produce a folder whose files are already within
 * NotebookLM's limits and named so its citations mean something, plus written
 * instructions — and then open the folder so the files can be dragged in.
 */
function packOptionsFrom(get: (k: string) => string | undefined) {
  const one = <T extends string>(k: string, allowed: readonly T[], fallback: T): T => {
    const v = get(k);
    return allowed.includes(v as T) ? (v as T) : fallback;
  };
  return {
    group: one("group", ["show", "category", "flat"] as const, "show"),
    include: one("include", ["notes", "full"] as const, "notes"),
    scope: one("scope", ["all", "starred", "manual", "auto"] as const, "all"),
    maxWords: clampNum(get("maxWords"), 400_000, 10_000, WORDS_PER_SOURCE),
  };
}

app.get("/api/export/notebooklm/plan", (c) =>
  c.json(planPack(db, packOptionsFrom((k) => c.req.query(k))))
);

app.post("/api/export/notebooklm", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const opts = packOptionsFrom((k) => {
    const v = (body as Record<string, unknown>)[k];
    return v === undefined ? undefined : String(v);
  });
  try {
    const result = writePack(db, join(DATA_DIR, "exports"), opts);
    if ((body as { open?: boolean }).open !== false && process.platform === "win32") {
      execFile("cmd", ["/c", "start", "", result.dir]);
    }
    return c.json(result);
  } catch (err) {
    const message = (err as Error).message;
    // "Nothing matches" is the caller's choice, not a server fault.
    return c.json({ error: message }, /Nothing to export/.test(message) ? 400 : 500);
  }
});

app.post("/api/sync", (c) => {
  const report = runSync(c.req.query("full") === "1");
  if (!report) return c.json({ error: syncing ? "sync already running" : "no vault configured" }, 409);
  // Whatever just arrived should be searchable by meaning too, without being
  // asked for. Returns immediately; the job runs in its worker.
  topUpEmbeddings("after sync");
  return c.json({
    filesParsed: report.filesParsed,
    filesUnchanged: report.filesUnchanged,
    filesSkipped: report.filesSkipped,
    snipsNew: report.snipsNew,
    warnings: report.warnings.length,
    totals: report.totals,
  });
});

/**
 * A misspelled API path used to fall through to the SPA and answer 200 with a
 * page of HTML, so a typo looked like a working endpoint returning nonsense.
 * It hid three wrong paths in this project's own testing. Anything under /api
 * that got this far does not exist, and should say so.
 */
app.all("/api/*", (c) => c.json({ error: `No such endpoint: ${c.req.path}` }, 404));

// Static SPA (built by `npm run build:web`), with client-route fallback.
app.use("/*", serveStatic({ root: relative(process.cwd(), WEB_DIST) }));
app.get("*", (c) => {
  const indexPath = join(WEB_DIST, "index.html");
  if (!existsSync(indexPath))
    return c.text("Web UI not built yet. Run: npm run build:web", 503);
  return c.html(readFileSync(indexPath, "utf8"));
});

// Sync on boot so the UI is always fresh (incremental → ~1s).
if (vaultPath) {
  console.log(`[resurface] vault: ${vaultPath}`);
  const report = runSync();
  if (report)
    console.log(
      `[resurface] boot sync: ${report.filesParsed} parsed, ${report.filesUnchanged} unchanged, ${report.warnings.length} warnings`
    );
} else {
  console.log("[resurface] WARNING: no vault found — set one via: npm run import -- --vault <path>");
}

// Upkeep, once the app is up: back up shortly after boot rather than during it,
// then keep the write-ahead log folded back in so it can't grow unbounded —
// an oversized WAL is where checkpointing started failing.
// Deferred: quick_check takes ~1.7s on a 300 MB library, and nothing is
// gained by making every startup wait for it.
setTimeout(() => runHealthCheck(), 5_000).unref();
setTimeout(() => maybeBackup("startup"), 20_000).unref();
// After the backup, so a cold start isn't three jobs deep before the first page
// renders. Catches snips that arrived while the app was closed.
setTimeout(() => topUpEmbeddings("catching up after startup"), 45_000).unref();
setInterval(() => maybeBackup("scheduled"), 6 * 3600_000).unref();
setInterval(() => {
  checkpoint(db);
  runHealthCheck();
}, 30 * 60_000).unref();

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const url = `http://${HOST}:${info.port}`;
  console.log(`[resurface] v${VERSION} serving at ${url}`);
  if (process.platform === "win32" && !process.argv.includes("--no-open")) {
    execFile("cmd", ["/c", "start", "", url]);
  }
});
