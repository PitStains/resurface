import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import {
  backupStatus,
  checkpoint,
  createSnapshot,
  createWorkBackup,
  healthCheck,
  listBackups,
  pruneBackups,
  restoreSnapshot,
  tableCounts,
  verifyBackup,
} from "../src/backup.ts";
import { recordReview } from "../src/review.ts";

let dir: string;
let dbPath: string;
let db: DatabaseSync;

function seed() {
  db.exec(`INSERT INTO shows (id, title) VALUES ('s1','Show')`);
  db.exec(`INSERT INTO episodes (id, show_id, title, last_snip_date) VALUES ('e1','s1','Ep','2026-05-01')`);
  for (const id of ["a", "b", "c"])
    db.prepare(
      `INSERT INTO snips (id, episode_id, ord, title, quote_text, summary_md) VALUES (?, 'e1', 1, ?, ?, 'summary')`
    ).run(id, `Title ${id}`, "A quote long enough to count as substantial content here.");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "resurface-backup-"));
  dbPath = join(dir, "resurface.db");
  db = openDb(dbPath);
  seed();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed by a restore test */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("createSnapshot", () => {
  it("writes a verified snapshot that contains the data", () => {
    const { info, verify } = createSnapshot(db, dbPath);
    expect(existsSync(info.path)).toBe(true);
    expect(verify.ok).toBe(true);
    expect(verify.integrity).toBe("ok");
    expect(verify.snips).toBe(3);
  });

  it("leaves no partial file behind", () => {
    createSnapshot(db, dbPath);
    expect(listBackups(dbPath).some((b) => b.file.startsWith(".partial"))).toBe(false);
  });

  it("keeps only the requested number of snapshots", () => {
    for (let i = 0; i < 4; i++) createSnapshot(db, dbPath, { keep: 2 });
    expect(listBackups(dbPath).filter((b) => b.kind === "snapshot")).toHaveLength(2);
  });

  it("works while the database is open and being written to", () => {
    // The whole point of VACUUM INTO over a file copy.
    db.prepare(`INSERT INTO snips (id, episode_id, ord, title) VALUES ('d','e1',2,'During')`).run();
    const { verify } = createSnapshot(db, dbPath);
    expect(verify.snips).toBe(4);
  });
});

describe("verifyBackup", () => {
  it("rejects a file that is not a database", () => {
    const bogus = join(dir, "not-a-db.db");
    writeFileSync(bogus, "definitely not sqlite");
    const v = verifyBackup(bogus);
    expect(v.ok).toBe(false);
    expect(v.problem).toBeTruthy();
  });

  it("refuses to keep a snapshot of an empty database, and leaves nothing behind", () => {
    // An empty library is far more likely to mean something went wrong than to
    // be worth overwriting a good backup with.
    const emptyPath = join(dir, "empty.db");
    const empty = openDb(emptyPath);
    try {
      expect(() => createSnapshot(empty, emptyPath)).toThrow(/no snips/);
      expect(listBackups(emptyPath)).toEqual([]);
    } finally {
      empty.close();
    }
  });
});

describe("verifyBackup against the source", () => {
  it("rejects a copy that lost a table the source still has", () => {
    // Exactly the failure seen in the field: a snapshot that is valid SQLite
    // and passes integrity_check, but silently arrived without its vectors.
    const { info } = createSnapshot(db, dbPath);
    const copy = openDb(info.path);
    copy.exec(`DELETE FROM snip_vectors`);
    copy.close();

    const v = verifyBackup(info.path, { snips: 3, snip_vectors: 10 });
    expect(v.integrity).toBe("ok"); // still a perfectly valid database
    expect(v.ok).toBe(false); // ...but not a usable backup
    expect(v.problem).toMatch(/missing data/);
  });

  it("accepts a copy that matches its source", () => {
    const { verify } = createSnapshot(db, dbPath);
    expect(verify.ok).toBe(true);
    expect(verify.problem).toBeNull();
  });

  it("tolerates the tiny drift of a write landing mid-copy", () => {
    const { info } = createSnapshot(db, dbPath);
    // One row behind out of a thousand is a race, not damage.
    expect(verifyBackup(info.path, { snips: 3, snip_vectors: 0 }).ok).toBe(true);
  });

  it("refuses to restore a snapshot that has lost data since it was verified", () => {
    // The manifest is what makes this catchable: at restore time there may be
    // no healthy source left to compare against.
    const { info } = createSnapshot(db, dbPath);
    const copy = openDb(info.path);
    copy.exec(`DELETE FROM snips`);
    copy.close();
    db.close();
    expect(() => restoreSnapshot(dbPath, info.file)).toThrow();
    db = openDb(dbPath);
  });

  it("writes a manifest beside each snapshot, and never lists it as a backup", () => {
    const { info } = createSnapshot(db, dbPath);
    expect(existsSync(`${info.path}.manifest.json`)).toBe(true);
    expect(listBackups(dbPath).some((b) => b.file.endsWith(".manifest.json"))).toBe(false);
  });

  it("removes the manifest when the snapshot it describes is pruned", () => {
    const first = createSnapshot(db, dbPath, { keep: 5 }).info;
    for (let i = 0; i < 2; i++) createSnapshot(db, dbPath, { keep: 1 });
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(`${first.path}.manifest.json`)).toBe(false);
  });

  it("counts the tables worth guarding", () => {
    const counts = tableCounts(db);
    expect(Object.keys(counts)).toContain("snip_vectors");
    expect(Object.keys(counts)).toContain("categories");
    expect(counts.snips).toBe(3);
  });
});

describe("createWorkBackup", () => {
  it("captures the things the vault cannot rebuild", () => {
    recordReview(db, "a", "keep", { today: "2026-07-21" });
    db.exec(`INSERT INTO bookmarks (entity_type, entity_id) VALUES ('snip','b')`);
    const info = createWorkBackup(db, dbPath);
    const payload = JSON.parse(readFileSync(info.path, "utf8"));
    expect(payload.reviewState).toHaveLength(1);
    expect(payload.reviewLog).toHaveLength(1);
    expect(payload.bookmarks).toHaveLength(1);
  });

  it("is small enough to keep many of", () => {
    recordReview(db, "a", "keep", { today: "2026-07-21" });
    expect(createWorkBackup(db, dbPath).sizeBytes).toBeLessThan(64 * 1024);
  });

  it("prunes independently of snapshots", () => {
    createSnapshot(db, dbPath);
    for (let i = 0; i < 3; i++) createWorkBackup(db, dbPath, { keep: 2 });
    const all = listBackups(dbPath);
    expect(all.filter((b) => b.kind === "work")).toHaveLength(2);
    expect(all.filter((b) => b.kind === "snapshot")).toHaveLength(1);
  });
});

describe("restoreSnapshot", () => {
  it("brings back data that was deleted after the backup", () => {
    recordReview(db, "a", "keep", { today: "2026-07-21" });
    const { info } = createSnapshot(db, dbPath);
    db.exec(`DELETE FROM review_state`);
    expect((db.prepare(`SELECT COUNT(*) c FROM review_state`).get() as { c: number }).c).toBe(0);
    db.close();

    restoreSnapshot(dbPath, info.file);

    db = openDb(dbPath);
    expect((db.prepare(`SELECT COUNT(*) c FROM review_state`).get() as { c: number }).c).toBe(1);
  });

  it("sets the replaced database aside instead of deleting it", () => {
    const { info } = createSnapshot(db, dbPath);
    db.close();
    const { setAside } = restoreSnapshot(dbPath, info.file);
    expect(existsSync(join(setAside, "resurface.db"))).toBe(true);
    db = openDb(dbPath);
  });

  it("refuses a backup that fails verification", () => {
    const bogus = join(dir, "backups", "resurface-broken.db");
    createSnapshot(db, dbPath); // ensures the directory exists
    writeFileSync(bogus, "corrupt");
    expect(() => restoreSnapshot(dbPath, "resurface-broken.db")).toThrow(/verification/);
  });

  it("refuses a backup that isn't there", () => {
    expect(() => restoreSnapshot(dbPath, "nope.db")).toThrow(/No such backup/);
  });
});

describe("backupStatus", () => {
  it("reports both kinds and the newest of each", () => {
    createSnapshot(db, dbPath);
    createWorkBackup(db, dbPath);
    const s = backupStatus(dbPath);
    expect(s.snapshots).toHaveLength(1);
    expect(s.work).toHaveLength(1);
    expect(s.lastSnapshotAt).toBeTruthy();
    expect(s.totalBytes).toBeGreaterThan(0);
  });

  it("is empty and harmless before any backup exists", () => {
    const s = backupStatus(dbPath);
    expect(s.snapshots).toEqual([]);
    expect(s.lastSnapshotAt).toBeNull();
  });
});

describe("checkpoint", () => {
  it("folds the write-ahead log back without erroring", () => {
    db.prepare(`INSERT INTO snips (id, episode_id, ord, title) VALUES ('z','e1',9,'Z')`).run();
    expect(checkpoint(db)).not.toBeNull();
  });
});

describe("healthCheck", () => {
  it("reports a sound database as ok", () => {
    const h = healthCheck(db, dbPath);
    expect(h.ok).toBe(true);
    expect(h.detail).toBe("ok");
  });

  it("points at the newest snapshot to fall back on", () => {
    const { info } = createSnapshot(db, dbPath);
    expect(healthCheck(db, dbPath).suggestedBackup).toBe(info.file);
  });

  it("has nothing to suggest before any backup exists", () => {
    expect(healthCheck(db, dbPath).suggestedBackup).toBeNull();
  });

  it("survives being asked about a closed database instead of throwing", () => {
    // Health checks run on a timer; one must never be able to take the app down.
    const doomed = openDb(join(dir, "closed.db"));
    doomed.close();
    const h = healthCheck(doomed);
    expect(h.ok).toBe(false);
    expect(h.detail.length).toBeGreaterThan(0);
  });
});

describe("pruneBackups", () => {
  it("keeps the newest and removes the rest", () => {
    const made = [createSnapshot(db, dbPath).info, createSnapshot(db, dbPath).info, createSnapshot(db, dbPath).info];
    pruneBackups(dbPath, "snapshot", 1);
    const left = listBackups(dbPath);
    expect(left).toHaveLength(1);
    expect(left[0].file).toBe(made[made.length - 1].file);
  });
});
