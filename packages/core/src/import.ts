import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PARSER_VERSION, parseEpisodeFile, sha1 } from "./parser.ts";
import { setSnipTags } from "./tags.ts";
import { classifyAll } from "./snipkind.ts";
import type { ImportReport, ParsedEpisode } from "./types.ts";

const IGNORED_DIRS = new Set([".obsidian", "Base", ".git", "node_modules"]);

function* walkMarkdownFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || /backup/i.test(entry.name)) continue;
      yield* walkMarkdownFiles(join(dir, entry.name));
    } else if (entry.name.toLowerCase().endsWith(".md") && entry.name.toLowerCase() !== "readme.md") {
      yield join(dir, entry.name);
    }
  }
}

function upsertEpisode(db: DatabaseSync, ep: ParsedEpisode, filePath: string, fileHash: string) {
  db.prepare(
    `INSERT INTO shows (id, title, author, url, image_url) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, author=excluded.author,
       url=excluded.url, image_url=excluded.image_url`
  ).run(ep.showId, ep.showTitle, ep.showAuthor, ep.showUrl, ep.showImageUrl);

  db.prepare(
    `INSERT INTO episodes (id, show_id, title, publish_date, duration_sec, last_snip_date,
       export_date, ai_description, url, image_url, file_path, file_hash, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET show_id=excluded.show_id, title=excluded.title,
       publish_date=excluded.publish_date, duration_sec=excluded.duration_sec,
       last_snip_date=excluded.last_snip_date, export_date=excluded.export_date,
       ai_description=excluded.ai_description, url=excluded.url, image_url=excluded.image_url,
       file_path=excluded.file_path, file_hash=excluded.file_hash, archived=0`
  ).run(
    ep.id, ep.showId, ep.title, ep.publishDate, ep.durationSec, ep.lastSnipDate,
    ep.exportDate, ep.aiDescription, ep.url, ep.imageUrl, filePath, fileHash
  );

  for (const g of ep.guests) {
    db.prepare(
      `INSERT INTO guests (id, name, url) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=COALESCE(excluded.url, guests.url)`
    ).run(g.id, g.name, g.url);
    db.prepare(`INSERT OR IGNORE INTO episode_guests (episode_id, guest_id) VALUES (?, ?)`).run(ep.id, g.id);
  }
  for (const b of ep.books) {
    db.prepare(
      `INSERT INTO books (id, title, author, url) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title,
         author=COALESCE(excluded.author, books.author), url=COALESCE(excluded.url, books.url)`
    ).run(b.id, b.title, b.author, b.url);
    db.prepare(`INSERT OR IGNORE INTO episode_books (episode_id, book_id) VALUES (?, ?)`).run(ep.id, b.id);
  }
}

/** Import (or re-import) the vault Data folder. Idempotent: run twice → same DB. */
export function importVault(
  db: DatabaseSync,
  vaultDataDir: string,
  opts: { force?: boolean } = {}
): ImportReport {
  const startedAt = new Date().toISOString();

  // A parser upgrade must re-parse files whose bytes are unchanged.
  const verRow = db.prepare("SELECT value_json FROM settings WHERE key = 'parser_version'").get() as
    | { value_json: string }
    | undefined;
  // No stored version row = DB written by a pre-versioning parser (or brand new,
  // where forcing is a no-op) → re-parse everything.
  const force = opts.force === true || !verRow || JSON.parse(verRow.value_json) !== PARSER_VERSION;
  const report: Omit<ImportReport, "finishedAt" | "totals"> = {
    startedAt,
    vaultPath: vaultDataDir,
    filesSeen: 0,
    filesParsed: 0,
    filesUnchanged: 0,
    filesSkipped: 0,
    snipsNew: 0,
    snipsUpdated: 0,
    snipsArchived: 0,
    episodesArchived: 0,
    warnings: [],
  };

  const hashByPath = new Map<string, string>(
    (db.prepare("SELECT file_path, file_hash FROM episodes WHERE archived = 0").all() as {
      file_path: string;
      file_hash: string;
    }[]).map((r) => [r.file_path, r.file_hash])
  );
  const seenPaths = new Set<string>();

  for (const absPath of walkMarkdownFiles(vaultDataDir)) {
    const relPath = relative(vaultDataDir, absPath);
    report.filesSeen++;
    seenPaths.add(relPath);
    let raw: string;
    try {
      raw = readFileSync(absPath, "utf8");
    } catch (err) {
      report.filesSkipped++;
      report.warnings.push({ file: relPath, message: `unreadable: ${(err as Error).message}` });
      continue;
    }
    const fileHash = sha1(raw);
    if (!force && hashByPath.get(relPath) === fileHash) {
      report.filesUnchanged++;
      continue;
    }

    let ep: ParsedEpisode;
    try {
      ep = parseEpisodeFile(raw, relPath);
    } catch (err) {
      report.filesSkipped++;
      report.warnings.push({ file: relPath, message: `parse failed: ${(err as Error).message}` });
      continue;
    }
    for (const w of ep.warnings) report.warnings.push({ file: relPath, message: w });

    db.exec("BEGIN");
    try {
      upsertEpisode(db, ep, relPath, fileHash);

      const existing = new Set(
        (db.prepare("SELECT id FROM snips WHERE episode_id = ?").all(ep.id) as { id: string }[]).map((r) => r.id)
      );
      const inFile = new Set<string>();
      for (const s of ep.snips) {
        inFile.add(s.id);
        if (existing.has(s.id)) report.snipsUpdated++;
        else report.snipsNew++;
        db.prepare(
          `INSERT INTO snips (id, episode_id, ord, title, share_url, start_sec, end_sec, duration_sec,
             summary_md, quote_text, quote_attribution, quote_caption, transcript_md, created_date,
             favorited, tags_json, archived)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET episode_id=excluded.episode_id, ord=excluded.ord,
             title=excluded.title, share_url=excluded.share_url, start_sec=excluded.start_sec,
             end_sec=excluded.end_sec, duration_sec=excluded.duration_sec, summary_md=excluded.summary_md,
             quote_text=excluded.quote_text, quote_attribution=excluded.quote_attribution,
             quote_caption=excluded.quote_caption, transcript_md=excluded.transcript_md,
             created_date=COALESCE(excluded.created_date, snips.created_date),
             favorited=excluded.favorited, tags_json=excluded.tags_json, archived=0`
        ).run(
          s.id, ep.id, s.ord, s.title, s.shareUrl, s.startSec, s.endSec, s.durationSec,
          s.summaryMd, s.quoteText, s.quoteAttribution, s.quoteCaption, s.transcriptMd, s.createdDate,
          s.favorited ? 1 : 0, s.tags.length > 0 ? JSON.stringify(s.tags) : null
        );
        // The vault is the source of truth for tags on snips it still contains,
        // so untagging in Snipd propagates here; snips missing from the vault
        // keep their last-known tags (never-delete).
        setSnipTags(db, s.id, s.tags);
      }
      // Some feeds export episode_duration_minutes: 0 — fall back to the furthest
      // snip end so estimated hours aren't undercounted.
      if (!ep.durationSec) {
        const maxEnd = Math.max(0, ...ep.snips.map((s) => s.endSec ?? 0));
        if (maxEnd > 0) db.prepare("UPDATE episodes SET duration_sec = ? WHERE id = ?").run(maxEnd, ep.id);
      }
      // Snips gone from a rewritten file are NEVER deleted — they're flagged as
      // missing-from-vault (`archived=1`) but stay visible everywhere. This
      // protects against vault corruption/retention limits; deliberate deletions
      // in the Snipd app persist here with a badge.
      for (const id of existing) {
        if (!inFile.has(id)) {
          db.prepare("UPDATE snips SET archived = 1 WHERE id = ?").run(id);
          report.snipsArchived++;
        }
      }
      db.exec("COMMIT");
      report.filesParsed++;
    } catch (err) {
      db.exec("ROLLBACK");
      report.filesSkipped++;
      report.warnings.push({ file: relPath, message: `import failed: ${(err as Error).message}` });
    }
  }

  // Episode files that disappeared entirely → soft-archive episode + snips.
  for (const [path] of hashByPath) {
    if (!seenPaths.has(path)) {
      const row = db.prepare("SELECT id FROM episodes WHERE file_path = ? AND archived = 0").get(path) as
        | { id: string }
        | undefined;
      if (row) {
        db.prepare("UPDATE episodes SET archived = 1 WHERE id = ?").run(row.id);
        db.prepare("UPDATE snips SET archived = 1 WHERE episode_id = ?").run(row.id);
        report.episodesArchived++;
      }
    }
  }

  db.prepare(
    "INSERT INTO settings (key, value_json) VALUES ('parser_version', ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json"
  ).run(JSON.stringify(PARSER_VERSION));

  // Kind is derived from each note's shape, so it has to be recomputed when
  // notes arrive or change. User overrides are left alone.
  classifyAll(db);

  const finishedAt = new Date().toISOString();
  const totals = {
    shows: (db.prepare("SELECT COUNT(*) c FROM shows").get() as { c: number }).c,
    episodes: (db.prepare("SELECT COUNT(*) c FROM episodes").get() as { c: number }).c,
    snips: (db.prepare("SELECT COUNT(*) c FROM snips").get() as { c: number }).c,
  };

  db.prepare(
    `INSERT INTO import_runs (started_at, finished_at, vault_path, files_seen, files_parsed,
       files_unchanged, files_skipped, snips_new, snips_updated, snips_archived, episodes_archived, warnings_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    startedAt, finishedAt, vaultDataDir, report.filesSeen, report.filesParsed, report.filesUnchanged,
    report.filesSkipped, report.snipsNew, report.snipsUpdated, report.snipsArchived, report.episodesArchived,
    JSON.stringify(report.warnings.slice(0, 500))
  );

  return { ...report, finishedAt, totals };
}
