import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { backfillSnipTags } from "./tags.ts";
import { classifyAll } from "./snipkind.ts";

/** Ordered migrations; each runs once, recorded in schema_migrations. */
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "001_core_content",
    sql: `
      CREATE TABLE shows (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT,
        url TEXT,
        image_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY,
        show_id TEXT NOT NULL REFERENCES shows(id),
        title TEXT NOT NULL,
        publish_date TEXT,
        duration_sec INTEGER,
        last_snip_date TEXT,
        export_date TEXT,
        ai_description TEXT,
        url TEXT,
        image_url TEXT,
        file_path TEXT,
        file_hash TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'snipd'
      );
      CREATE INDEX idx_episodes_show ON episodes(show_id, last_snip_date);
      CREATE INDEX idx_episodes_file ON episodes(file_path);
      CREATE TABLE snips (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL REFERENCES episodes(id),
        ord INTEGER NOT NULL,
        title TEXT,
        share_url TEXT,
        start_sec INTEGER,
        end_sec INTEGER,
        duration_sec INTEGER,
        summary_md TEXT,
        quote_text TEXT,
        quote_attribution TEXT,
        quote_caption TEXT,
        transcript_md TEXT,
        created_date TEXT,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_snips_episode ON snips(episode_id, ord);
      CREATE TABLE guests (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT
      );
      CREATE TABLE episode_guests (
        episode_id TEXT NOT NULL,
        guest_id TEXT NOT NULL,
        PRIMARY KEY (episode_id, guest_id)
      );
      CREATE TABLE books (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT,
        url TEXT
      );
      CREATE TABLE episode_books (
        episode_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        PRIMARY KEY (episode_id, book_id)
      );
      CREATE TABLE import_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        vault_path TEXT,
        files_seen INTEGER,
        files_parsed INTEGER,
        files_unchanged INTEGER,
        files_skipped INTEGER,
        snips_new INTEGER,
        snips_updated INTEGER,
        snips_archived INTEGER,
        episodes_archived INTEGER,
        warnings_json TEXT
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `,
  },
  {
    name: "002_search_favorites",
    sql: `
      CREATE TABLE favorites (
        entity_type TEXT NOT NULL CHECK (entity_type IN ('show','episode','snip')),
        entity_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (entity_type, entity_id)
      );
      CREATE TABLE saved_searches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        query_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT
      );
      CREATE VIRTUAL TABLE snips_fts USING fts5(
        title, quote_text, summary_md, transcript_md,
        content='snips', content_rowid='rowid'
      );
      CREATE TRIGGER snips_fts_ai AFTER INSERT ON snips BEGIN
        INSERT INTO snips_fts(rowid, title, quote_text, summary_md, transcript_md)
        VALUES (new.rowid, new.title, new.quote_text, new.summary_md, new.transcript_md);
      END;
      CREATE TRIGGER snips_fts_ad AFTER DELETE ON snips BEGIN
        INSERT INTO snips_fts(snips_fts, rowid, title, quote_text, summary_md, transcript_md)
        VALUES ('delete', old.rowid, old.title, old.quote_text, old.summary_md, old.transcript_md);
      END;
      CREATE TRIGGER snips_fts_au AFTER UPDATE ON snips BEGIN
        INSERT INTO snips_fts(snips_fts, rowid, title, quote_text, summary_md, transcript_md)
        VALUES ('delete', old.rowid, old.title, old.quote_text, old.summary_md, old.transcript_md);
        INSERT INTO snips_fts(rowid, title, quote_text, summary_md, transcript_md)
        VALUES (new.rowid, new.title, new.quote_text, new.summary_md, new.transcript_md);
      END;
      INSERT INTO snips_fts(rowid, title, quote_text, summary_md, transcript_md)
        SELECT rowid, title, quote_text, summary_md, transcript_md FROM snips;
    `,
  },
  {
    // Terminology split: "favorites" come from the Snipd app (⭐ in the export,
    // read-only here); in-app stars are "bookmarks".
    name: "003_snipd_favorites_bookmarks",
    sql: `
      ALTER TABLE favorites RENAME TO bookmarks;
      ALTER TABLE snips ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE snips ADD COLUMN tags_json TEXT;
      CREATE INDEX idx_snips_favorited ON snips(favorited) WHERE favorited = 1;
    `,
  },
  {
    // Snipd tags become queryable. snips.tags_json stays as the raw parser
    // record (audit trail); snip_tags is the normalized projection used for
    // filtering, facets and the /tags pages. Backfilled below from tags_json,
    // so no vault re-read is needed on upgrade.
    name: "004_tags",
    sql: `
      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'snipd',
        first_seen TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE snip_tags (
        snip_id TEXT NOT NULL REFERENCES snips(id),
        tag_id INTEGER NOT NULL REFERENCES tags(id),
        PRIMARY KEY (snip_id, tag_id)
      );
      CREATE INDEX idx_snip_tags_tag ON snip_tags(tag_id);
    `,
  },
  {
    // Semantic layer: one vector per snip, stamped with the model that made it
    // so a model change invalidates cleanly. Vectors are derived data — they
    // can always be rebuilt from the snips themselves.
    name: "005_embeddings",
    sql: `
      CREATE TABLE snip_vectors (
        snip_id TEXT PRIMARY KEY REFERENCES snips(id),
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL,
        text_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_snip_vectors_model ON snip_vectors(model);
    `,
  },
  {
    // Topics (k-means over the vectors) and the 2-D map layout. Like vectors,
    // both are derived data: rebuilt on demand, never a source of truth.
    name: "006_clusters",
    sql: `
      CREATE TABLE clusters (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL,
        terms_json TEXT NOT NULL,
        size INTEGER NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE snip_clusters (
        snip_id TEXT PRIMARY KEY REFERENCES snips(id),
        cluster_id INTEGER NOT NULL,
        similarity REAL NOT NULL
      );
      CREATE INDEX idx_snip_clusters_cluster ON snip_clusters(cluster_id, similarity DESC);
      CREATE TABLE snip_layout (
        snip_id TEXT PRIMARY KEY REFERENCES snips(id),
        x REAL NOT NULL,
        y REAL NOT NULL
      );
    `,
  },
  {
    // Categories: a user-owned taxonomy, seeded from discovered topics but
    // renamable, mergeable and correctable. Unlike topics (recomputed wholesale)
    // these persist — the names and manual assignments are the user's work.
    name: "007_categories",
    sql: `
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        note TEXT,
        source TEXT NOT NULL DEFAULT 'seeded',
        -- What the category means, as a vector. Persisted so a strict cutoff
        -- can empty a category without destroying its definition.
        centroid BLOB,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE category_snips (
        category_id INTEGER NOT NULL REFERENCES categories(id),
        snip_id TEXT NOT NULL REFERENCES snips(id),
        score REAL NOT NULL DEFAULT 0,
        manual INTEGER NOT NULL DEFAULT 0, -- 1 = the user said so; never overwritten
        PRIMARY KEY (category_id, snip_id)
      );
      CREATE INDEX idx_category_snips_snip ON category_snips(snip_id);
      CREATE INDEX idx_category_snips_cat ON category_snips(category_id, score DESC);
    `,
  },
  {
    // Where a snip came from: Snipd's own template, or the user's hands. Derived
    // from the note's shape (see snipkind.ts), so it is recomputed on import —
    // except where the user has overruled it, which is permanent.
    name: "008_snip_kind",
    sql: `
      ALTER TABLE snips ADD COLUMN kind TEXT NOT NULL DEFAULT 'auto';
      ALTER TABLE snips ADD COLUMN kind_confident INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE snips ADD COLUMN kind_reason TEXT;
      ALTER TABLE snips ADD COLUMN kind_source TEXT NOT NULL DEFAULT 'inferred';
      CREATE INDEX idx_snips_kind ON snips(kind);
    `,
  },
  {
    // Resurfacing (Phase 5). This is the first table whose contents cannot be
    // rebuilt from the vault — a review history is made by the user, not the
    // export — so it is written conservatively and never deleted from.
    name: "009_review",
    sql: `
      CREATE TABLE review_state (
        snip_id TEXT PRIMARY KEY REFERENCES snips(id),
        -- Spaced repetition position: index into REVIEW_INTERVALS.
        level INTEGER NOT NULL DEFAULT 0,
        due_date TEXT,
        times_shown INTEGER NOT NULL DEFAULT 0,
        last_shown_at TEXT,
        -- "Stop showing me this": excluded from review, still in the library,
        -- still searchable. Never a delete.
        muted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_review_due ON review_state(due_date) WHERE muted = 0;
      CREATE TABLE review_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snip_id TEXT NOT NULL REFERENCES snips(id),
        action TEXT NOT NULL,
        at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_review_log_snip ON review_log(snip_id, at);
    `,
  },
];

/**
 * Guard against a second process opening the same database.
 *
 * `node:sqlite` does not survive cross-process sharing of this file: a second
 * process reading while the server is up gets "malformed database schema" for
 * a database that is perfectly intact once it is alone — and under write load
 * the damage becomes real and permanent. One database file was lost that way.
 *
 * So a writer takes a lock naming its pid, and a second writer refuses to start
 * instead of risking the file. The lock is advisory and self-healing: a stale
 * lock from a crashed process is detected and taken over.
 */
function lockPath(dbPath: string): string {
  return `${dbPath}.lock`;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 tests existence without touching it
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours
  }
}

export class DatabaseBusyError extends Error {
  constructor(public readonly pid: number) {
    super(
      `Resurface is already running (process ${pid}) and has the database open. ` +
        `Close it first — two processes writing this file at once can corrupt it.`
    );
    this.name = "DatabaseBusyError";
  }
}

function acquireLock(dbPath: string): void {
  const path = lockPath(dbPath);
  try {
    const held = Number(readFileSync(path, "utf8").trim());
    if (Number.isFinite(held) && held !== process.pid && processAlive(held)) throw new DatabaseBusyError(held);
  } catch (err) {
    if (err instanceof DatabaseBusyError) throw err;
    // No lock file, or an unreadable one: ours to take.
  }
  writeFileSync(path, String(process.pid), "utf8");
  const release = () => {
    try {
      if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(130);
  });
}

export interface OpenDbOptions {
  /**
   * Run schema DDL on open. Only the owning process may do this: two
   * connections doing DDL (and flipping journal_mode) while a third writes
   * corrupted the database once already — SQLite ended up parsing a data page
   * as the schema page. Workers pass false and attach to a schema that the
   * main process has already finished migrating.
   */
  migrate?: boolean;
}

export function openDb(dbPath: string, opts: OpenDbOptions = {}): DatabaseSync {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  // Workers share the owning process's lock — they are threads, not processes.
  if (dbPath !== ":memory:" && opts.migrate !== false) acquireLock(dbPath);
  const db = new DatabaseSync(dbPath);
  // journal_mode is persistent, so only the migrating connection needs to set
  // it; a second connection flipping it mid-write is one of the races above.
  if (opts.migrate !== false) db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // Without this a concurrent writer fails instantly with SQLITE_BUSY instead
  // of waiting its turn — the embed worker writes 32k rows while the server
  // serves requests, so contention is normal and expected, not exceptional.
  db.exec("PRAGMA busy_timeout = 10000;");
  // Cap the write-ahead log. Left alone it grew past 190 MB here — twice, and
  // on both occasions the database was found damaged shortly after. Whether the
  // size caused the damage or merely accompanied it is unproven, but an
  // unbounded WAL is worth preventing on its own: this truncates it back after
  // each checkpoint instead of letting the file grow without limit.
  db.exec("PRAGMA journal_size_limit = 67108864;"); // 64 MB
  if (opts.migrate === false) return db;
  const applied = migrate(db);
  // Tag tables arrive empty; fill them from what the parser already stored so
  // upgrading is instant (no vault re-read, no PARSER_VERSION bump).
  if (applied.includes("004_tags")) backfillSnipTags(db);
  // Kinds are derived from note shape, so the column arrives empty and is
  // filled in place — no vault re-read, no PARSER_VERSION bump.
  if (applied.includes("008_snip_kind")) classifyAll(db);
  return db;
}

/** @returns names of migrations applied by this call (empty when up to date). */
export function migrate(db: DatabaseSync): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  const applied = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name)
  );
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))").run(m.name);
      db.exec("COMMIT");
      ran.push(m.name);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return ran;
}
