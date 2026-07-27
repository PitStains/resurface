import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, quarantineWal } from "../src/db.ts";

/**
 * What is *not* tested here, deliberately.
 *
 * The failure this recovery exists for — a write-ahead log that makes an
 * otherwise sound database open as "malformed" — cannot be produced on demand.
 * SQLite tolerates a remarkable amount: an all-zero log, a garbage log, a valid
 * header over garbage frames, and a genuine log belonging to a *different*
 * database were each opened without complaint (the last was replayed, which is
 * its own kind of alarming). Only a log whose frames pass their own checksums
 * and still leave the database inconsistent will do it, and that cannot be
 * forged from outside.
 *
 * So these tests cover the machinery — what it moves, what it keeps, what it
 * refuses to paper over — and the trigger itself stays a field observation.
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "resurface-wal-"));
  dbPath = join(dir, "resurface.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed() {
  const db = openDb(dbPath);
  db.exec(`INSERT INTO shows (id, title) VALUES ('s1','Show')`);
  db.exec(`INSERT INTO episodes (id, show_id, title) VALUES ('e1','s1','Ep')`);
  db.prepare(`INSERT INTO snips (id, episode_id, ord, title) VALUES ('a','e1',1,'Kept')`).run();
  db.close();
}

const quarantines = () => readdirSync(dir).filter((f) => f.startsWith("quarantined-wal-"));

describe("quarantineWal", () => {
  it("moves the log aside rather than deleting it", () => {
    // It can hold committed data that was never checkpointed. Deleting it would
    // turn a recoverable morning into a lost one.
    seed();
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(4096, 0xab));

    const moved = quarantineWal(dbPath);

    expect(moved).toBeTruthy();
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    const kept = join(moved!, "resurface.db-wal");
    expect(existsSync(kept)).toBe(true);
    expect(statSync(kept).size).toBe(4096);
  });

  it("takes the shared-memory file with it", () => {
    seed();
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(64));
    writeFileSync(`${dbPath}-shm`, Buffer.alloc(64));
    const moved = quarantineWal(dbPath);
    expect(existsSync(join(moved!, "resurface.db-shm"))).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("says so when there is no log to blame", () => {
    expect(quarantineWal(join(dir, "absent.db"))).toBeNull();
  });
});

describe("openDb", () => {
  it("leaves a healthy database entirely alone", () => {
    seed();
    const db = openDb(dbPath);
    // The log is present while the connection is; SQLite removes it on a clean
    // close, which is why this is asserted before closing rather than after.
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) c FROM snips`).get() as { c: number }).c).toBe(1);
    db.close();
    expect(quarantines()).toHaveLength(0);
  });

  it("arranges to close the database on the way out", () => {
    // The shutdown itself cannot be exercised here: on Windows a signal cannot
    // be delivered to this process without ending it, so what is checked is
    // that the handlers exist. That they close the database is the next test.
    const before = { exit: process.listenerCount("exit"), int: process.listenerCount("SIGINT") };
    const db = openDb(dbPath);
    expect(process.listenerCount("exit")).toBeGreaterThan(before.exit);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(before.int);
    db.close();
  });

  it("closing removes the log, which is the whole point of closing", () => {
    // A log left on disk is the state the app was three times unable to start
    // from. Shutdown used to release the lock and exit without closing.
    seed();
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO snips (id, episode_id, ord, title) VALUES ('b','e1',2,'More')`).run();
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    db.close();
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("still fails when the damage is in the database itself", () => {
    // Recovery must never turn a genuinely broken file into a silent success.
    writeFileSync(dbPath, "this is not a database at all, not even slightly");
    expect(() => openDb(dbPath)).toThrow();
  });

  it("releases the file handle when opening fails", () => {
    // An unclosed handle keeps the file locked on Windows, which would stop the
    // recovery from being able to move anything -- and stop the caller from
    // cleaning up afterwards.
    writeFileSync(dbPath, "not a database");
    expect(() => openDb(dbPath)).toThrow();
    expect(() => rmSync(dbPath, { force: true })).not.toThrow();
  });
});
