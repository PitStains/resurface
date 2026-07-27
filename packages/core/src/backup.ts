import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as Db } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Backups (Phase 6).
 *
 * Most of this database can be rebuilt from the vault: snips, tags, vectors,
 * topics. A few tables cannot, because the user made them rather than Snipd —
 * the review history above all, plus bookmarks, category names and pins, and
 * saved searches. Losing those loses work that exists nowhere else.
 *
 * Two tiers, because they answer different fears:
 *  - a **full snapshot** via `VACUUM INTO`, which writes a clean defragmented
 *    copy with no WAL attached, and is verified before it is kept. Restoring
 *    one gets everything back instantly with no re-embedding.
 *  - a **work file**, a few kilobytes of JSON holding only the irreplaceable
 *    rows. Cheap enough to keep many of, and readable without this program.
 *
 * A backup nobody has checked is a guess, so every snapshot is opened and
 * integrity-checked before it replaces the previous one.
 */

export const BACKUP_DIR_NAME = "backups";
/** Full snapshots are ~270 MB each, so the default keeps a useful few. */
export const DEFAULT_KEEP = 3;
export const DEFAULT_KEEP_WORK = 30;

function backupDir(dbPath: string): string {
  return join(dirname(dbPath), BACKUP_DIR_NAME);
}

/**
 * Millisecond precision, deliberately. At one-second resolution several
 * snapshots taken in the same second share a modification time, and pruning
 * "the oldest" then depends on filesystem ordering — it can delete the one you
 * meant to keep. Milliseconds also make the names sort chronologically as text.
 */
const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, "-").slice(0, 23);

/**
 * Timestamps only go down to the second, so two backups taken in the same
 * second would land on the same name and the second would silently destroy the
 * first. Suffix until the name is free.
 */
function freePath(dir: string, base: string, ext: string): { name: string; path: string } {
  for (let n = 0; ; n++) {
    const name = n === 0 ? `${base}${ext}` : `${base}-${n}${ext}`;
    const path = join(dir, name);
    if (!existsSync(path) && !existsSync(join(dir, `.partial-${name}`))) return { name, path };
  }
}

export interface BackupInfo {
  file: string;
  path: string;
  kind: "snapshot" | "work";
  sizeBytes: number;
  createdAt: string;
}

export interface VerifyResult {
  ok: boolean;
  integrity: string;
  snips: number;
  vectors: number;
  reviewed: number;
  bookmarks: number;
  categories: number;
  problem: string | null;
}

/** The tables a snapshot is checked against its source for. */
const COUNTED_TABLES = ["snips", "snip_vectors", "categories", "snip_clusters", "snip_tags", "review_log"] as const;

export type TableCounts = Record<string, number>;

export function tableCounts(db: DatabaseSync): TableCounts {
  const out: TableCounts = {};
  for (const t of COUNTED_TABLES) {
    try {
      out[t] = (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
    } catch {
      out[t] = 0; // table predates this migration
    }
  }
  return out;
}

/**
 * Open a backup file and prove it is readable and whole before trusting it.
 *
 * `expected` is what the source database held when the copy was taken. It
 * matters more than it sounds: a subtly damaged database can be vacuumed into
 * a file that is *internally* consistent — `integrity_check` says "ok" —
 * while having silently dropped whole tables on the way out. That happened
 * here: a snapshot passed with every one of 32,196 vectors and all 35
 * categories missing, because the only questions asked were "is this valid
 * SQLite?" and "does it have any snips?". Now a copy has to still contain what
 * it was copied from.
 */
export function verifyBackup(path: string, expected?: TableCounts): VerifyResult {
  const empty: VerifyResult = {
    ok: false, integrity: "unreadable", snips: 0, vectors: 0, reviewed: 0,
    bookmarks: 0, categories: 0, problem: null,
  };
  let db: DatabaseSync | null = null;
  try {
    db = new Db(path, { readOnly: true });
    const integrity = (db.prepare("PRAGMA integrity_check").all() as unknown as Record<string, string>[])
      .map((r) => Object.values(r)[0])
      .join(" | ");
    const count = (table: string) => {
      try {
        return (db!.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
      } catch {
        return 0; // table predates this migration; not a failure
      }
    };
    const snips = count("snips");
    const result: VerifyResult = {
      ok: integrity === "ok" && snips > 0,
      integrity,
      snips,
      vectors: count("snip_vectors"),
      reviewed: count("review_log"),
      bookmarks: count("bookmarks"),
      categories: count("categories"),
      problem: null,
    };
    if (integrity !== "ok") result.problem = `integrity check said: ${integrity}`;
    else if (snips === 0) result.problem = "the backup contains no snips";
    else if (expected) {
      // A vacuum copies; it never legitimately loses rows. Anything materially
      // short means the source was damaged, and keeping the copy would quietly
      // enshrine that loss as the thing you restore from.
      const lost = Object.entries(expected)
        .filter(([table, n]) => n > 0 && count(table) < Math.floor(n * 0.99))
        .map(([table, n]) => `${table} ${count(table).toLocaleString()} of ${n.toLocaleString()}`);
      if (lost.length > 0) {
        result.ok = false;
        result.problem = `the copy is missing data the database still has — ${lost.join(", ")}`;
      }
    }
    return result;
  } catch (err) {
    return { ...empty, problem: (err as Error).message };
  } finally {
    db?.close();
  }
}

/**
 * A full snapshot. `VACUUM INTO` is used rather than copying the file because
 * it writes a consistent, already-checkpointed database even while this process
 * has the original open — no WAL to carry along, and no torn copy.
 */
export function createSnapshot(
  db: DatabaseSync,
  dbPath: string,
  opts: { keep?: number } = {}
): { info: BackupInfo; verify: VerifyResult } {
  const dir = backupDir(dbPath);
  mkdirSync(dir, { recursive: true });
  const { name, path: final } = freePath(dir, `resurface-${stamp()}`, ".db");
  // What the live database holds right now, to compare the copy against.
  const before = tableCounts(db);
  // Write under a temporary name so a failed or half-written vacuum can never
  // be mistaken for a good backup.
  const tmp = join(dir, `.partial-${name}`);
  if (existsSync(tmp)) rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''").replace(/\\/g, "/")}'`);

  const verify = verifyBackup(tmp, before);
  if (!verify.ok) {
    rmSync(tmp, { force: true });
    throw new Error(`Backup failed verification and was discarded: ${verify.problem ?? "unknown"}`);
  }
  renameSync(tmp, final);
  // Record what this snapshot held when it was verified, so a restore can
  // check the file still matches rather than trusting its name and date.
  writeFileSync(`${final}.manifest.json`, JSON.stringify({ verifiedAt: new Date().toISOString(), counts: before }, null, 1), "utf8");
  pruneBackups(dbPath, "snapshot", opts.keep ?? DEFAULT_KEEP);
  return {
    info: { file: name, path: final, kind: "snapshot", sizeBytes: statSync(final).size, createdAt: new Date().toISOString() },
    verify,
  };
}

/**
 * The small one: only what the vault cannot regenerate. Kept as JSON so it
 * stays readable, diffable, and restorable by hand if it ever came to that.
 */
export function createWorkBackup(db: DatabaseSync, dbPath: string, opts: { keep?: number } = {}): BackupInfo {
  const dir = backupDir(dbPath);
  mkdirSync(dir, { recursive: true });
  const table = (sql: string) => {
    try {
      return db.prepare(sql).all() as unknown[];
    } catch {
      return [];
    }
  };
  const payload = {
    exportedAt: new Date().toISOString(),
    note: "The parts of Resurface that cannot be rebuilt from your Snipd vault.",
    reviewState: table("SELECT * FROM review_state"),
    reviewLog: table("SELECT * FROM review_log"),
    bookmarks: table("SELECT * FROM bookmarks"),
    savedSearches: table("SELECT * FROM saved_searches"),
    // Names, notes and pins are the user's work; centroids are derived, so the
    // blob is deliberately left out to keep the file small and legible.
    categories: table("SELECT id, name, note, source, created_at FROM categories"),
    categorySnips: table("SELECT * FROM category_snips WHERE manual = 1"),
    snipKindOverrides: table("SELECT id, kind FROM snips WHERE kind_source = 'user'"),
  };
  const { name, path: final } = freePath(dir, `work-${stamp()}`, ".json");
  writeFileSync(final, JSON.stringify(payload, null, 1), "utf8");
  pruneBackups(dbPath, "work", opts.keep ?? DEFAULT_KEEP_WORK);
  return { file: name, path: final, kind: "work", sizeBytes: statSync(final).size, createdAt: payload.exportedAt };
}

export function listBackups(dbPath: string): BackupInfo[] {
  const dir = backupDir(dbPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.startsWith(".partial-"))
    .filter((f) => f.endsWith(".db") || (f.endsWith(".json") && !f.endsWith(".manifest.json")))
    .map((f) => {
      const p = join(dir, f);
      const s = statSync(p);
      return {
        file: f,
        path: p,
        kind: (f.endsWith(".json") ? "work" : "snapshot") as BackupInfo["kind"],
        sizeBytes: s.size,
        createdAt: s.mtime.toISOString(),
      };
    })
    // Newest first. The filename breaks ties, since it carries the same clock
    // at higher resolution than the filesystem's timestamp.
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.file.localeCompare(a.file));
}

/** Keep the newest N of a kind. Never touches the other kind. */
export function pruneBackups(dbPath: string, kind: BackupInfo["kind"], keep: number): string[] {
  const removed: string[] = [];
  const ofKind = listBackups(dbPath).filter((b) => b.kind === kind);
  for (const b of ofKind.slice(Math.max(0, keep))) {
    rmSync(b.path, { force: true });
    rmSync(`${b.path}.manifest.json`, { force: true }); // never orphan a manifest
    removed.push(b.file);
  }
  return removed;
}

/**
 * Put a snapshot back. The caller must have closed the database first — this
 * moves files around underneath it.
 *
 * The database being replaced is never deleted, only renamed aside, because a
 * restore is exactly the moment someone might realise they chose the wrong
 * backup.
 */
export function restoreSnapshot(dbPath: string, backupFile: string): { restored: string; setAside: string } {
  const dir = backupDir(dbPath);
  const src = join(dir, backupFile);
  if (!existsSync(src)) throw new Error(`No such backup: ${backupFile}`);
  // Check against what this snapshot recorded at creation, not just that it is
  // valid SQLite — a backup written from a damaged database can be perfectly
  // well-formed and still be missing everything that made it worth keeping.
  let expected: TableCounts | undefined;
  const manifest = `${src}.manifest.json`;
  if (existsSync(manifest)) {
    try {
      expected = (JSON.parse(readFileSync(manifest, "utf8")) as { counts: TableCounts }).counts;
    } catch {
      /* unreadable manifest: fall back to the structural check alone */
    }
  }
  const verify = verifyBackup(src, expected);
  if (!verify.ok) throw new Error(`Refusing to restore a backup that fails verification: ${verify.problem}`);

  const asideDir = join(dirname(dbPath), `replaced-${stamp()}`);
  mkdirSync(asideDir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = `${dbPath}${suffix}`;
    if (existsSync(f)) renameSync(f, join(asideDir, `resurface.db${suffix}`));
  }
  copyFileSync(src, dbPath);
  return { restored: backupFile, setAside: asideDir };
}

export interface BackupStatus {
  dir: string;
  snapshots: BackupInfo[];
  work: BackupInfo[];
  lastSnapshotAt: string | null;
  lastWorkAt: string | null;
  totalBytes: number;
}

export function backupStatus(dbPath: string): BackupStatus {
  const all = listBackups(dbPath);
  const snapshots = all.filter((b) => b.kind === "snapshot");
  const work = all.filter((b) => b.kind === "work");
  return {
    dir: backupDir(dbPath),
    snapshots,
    work,
    lastSnapshotAt: snapshots[0]?.createdAt ?? null,
    lastWorkAt: work[0]?.createdAt ?? null,
    totalBytes: all.reduce((n, b) => n + b.sizeBytes, 0),
  };
}

export interface HealthReport {
  ok: boolean;
  checkedAt: string;
  /** "ok", or SQLite's description of what is wrong. */
  detail: string;
  tookMs: number;
  /** The newest verified snapshot to fall back on, if there is one. */
  suggestedBackup: string | null;
  /** Write-ahead log size in bytes; watched because it grew unbounded twice. */
  walBytes: number | null;
}

/**
 * Is the database still sound?
 *
 * Four controlled experiments failed to reproduce corruption from concurrent
 * access — two processes, the old no-timeout DDL pattern, a force-kill during a
 * write, and a worker thread alongside the main one all left `integrity_check`
 * reporting ok. So the cause of the corruption seen earlier is *not* known to
 * be this program's own concurrency, and the honest response is to notice
 * damage immediately rather than to claim it has been prevented.
 *
 * `quick_check` is used rather than `integrity_check`: it catches the page-level
 * damage that actually occurred, and is fast enough to run on a timer without
 * competing with real work.
 */
export function healthCheck(db: DatabaseSync, dbPath?: string): HealthReport {
  const t0 = Date.now();
  let detail: string;
  try {
    detail = (db.prepare("PRAGMA quick_check(1)").all() as unknown as Record<string, string>[])
      .map((r) => Object.values(r)[0])
      .join(" | ");
  } catch (err) {
    detail = (err as Error).message;
  }
  const newest = dbPath ? listBackups(dbPath).find((b) => b.kind === "snapshot") : undefined;
  let walBytes: number | null = null;
  if (dbPath && existsSync(`${dbPath}-wal`)) walBytes = statSync(`${dbPath}-wal`).size;
  return {
    ok: detail === "ok",
    checkedAt: new Date().toISOString(),
    detail,
    tookMs: Date.now() - t0,
    suggestedBackup: newest?.file ?? null,
    walBytes,
  };
}

/**
 * Routine upkeep on the one connection that owns the file: fold the
 * write-ahead log back into the database so it cannot grow without bound.
 * PASSIVE never blocks and never fights a reader, so it is safe to run while
 * the app is serving.
 */
export function checkpoint(db: DatabaseSync): { busy: number; log: number; checkpointed: number } | null {
  try {
    return db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as unknown as {
      busy: number;
      log: number;
      checkpointed: number;
    };
  } catch {
    return null; // never let upkeep take the app down
  }
}
