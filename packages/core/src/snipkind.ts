import type { DatabaseSync } from "node:sqlite";

/**
 * Auto-generated vs. hand-made snips.
 *
 * Snipd creates most snips itself, from a fixed template. The tempting signal
 * is the section names in a hand-made note ("Main Theme", "Core Frameworks"),
 * but those are one user's chosen note types: they differ per person and drift
 * over time, so keying off them would classify only this vault, this year.
 *
 * So we identify the machine template *positively* and call everything else
 * hand-made. The template is rigid in a way prose never is, and the real corpus
 * shows just how rigid: of 32,196 snips, 28,076 have exactly two summary
 * bullets, 24,135 land between 200 and 300 characters — and only 61 fall
 * anywhere in the 400–1000 character range. The classifier's boundary sits in
 * that empty gap, which is why its exact value barely matters.
 *
 * Duration is deliberately not used. Hand-made snips run from seconds to whole
 * episodes, so length of audio says nothing about who made it.
 */

/** Middle of the observed gap between the template and everything longer. */
const AUTO_MAX_SUMMARY = 600;
/** The template is a two-bullet takeaway; a little slack for variants. */
const AUTO_MAX_BULLETS = 3;
/** Below this a summary is too slight to argue either way. */
const TRIVIAL_SUMMARY = 40;

export type SnipKind = "auto" | "manual";
export type KindSource = "inferred" | "user";

export interface KindVerdict {
  kind: SnipKind;
  /** False when the snip sits near the boundary and deserves a human look. */
  confident: boolean;
  /** Plain-language justification, shown in the UI so a user can disagree. */
  reason: string;
}

export interface KindInput {
  summary_md: string | null;
  quote_text: string | null;
}

/**
 * Lines that act as section headers, counted structurally rather than by name
 * so a different note format still reads as structure.
 */
function countHeadings(md: string): number {
  let n = 0;
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^#{1,6}\s+\S/.test(t)) n++; // markdown heading
    else if (/^\*{0,2}\d+[.)]\s*[A-Z][^.!?]{2,60}\*{0,2}:?\s*$/.test(t)) n++; // "3. Insight Extraction"
    else if (/^\*\*[^*]{3,60}\*\*:?\s*$/.test(t)) n++; // bold label alone on a line
    else if (/^[A-Z][A-Za-z /&-]{2,40}:\s*$/.test(t)) n++; // "Takeaways:"
  }
  return n;
}

function countBullets(md: string): number {
  return md.split(/\r?\n/).filter((l) => /^\s*[-*+]\s+\S/.test(l)).length;
}

export function classifySnip(s: KindInput): KindVerdict {
  const md = (s.summary_md ?? "").trim();
  const headings = countHeadings(md);
  const bullets = countBullets(md);

  if (headings > 0)
    return {
      kind: "manual",
      confident: true,
      reason: `note is organised into ${headings} section${headings === 1 ? "" : "s"}`,
    };

  // No note at all, or a stub: Snipd's template always writes a summary, so an
  // empty one means somebody clipped audio without asking for notes.
  if (md.length < TRIVIAL_SUMMARY)
    return { kind: "manual", confident: false, reason: "clipped with little or no note" };

  if (md.length <= AUTO_MAX_SUMMARY && bullets <= AUTO_MAX_BULLETS && !!s.quote_text)
    return {
      kind: "auto",
      confident: md.length < 400,
      reason: `matches the auto template (${bullets} bullet${bullets === 1 ? "" : "s"}, ${md.length} characters, one quote)`,
    };

  if (md.length > AUTO_MAX_SUMMARY)
    return {
      kind: "manual",
      confident: md.length > 1000,
      reason: `note runs to ${md.length} characters, far past the auto template`,
    };

  return { kind: "manual", confident: false, reason: "does not match the auto template" };
}

/** Recompute for every snip whose kind the user hasn't overridden. */
export function classifyAll(db: DatabaseSync): { auto: number; manual: number; unsure: number } {
  const rows = db
    .prepare(`SELECT id, summary_md, quote_text FROM snips WHERE kind_source IS NOT 'user'`)
    .all() as unknown as (KindInput & { id: string })[];
  const update = db.prepare(
    `UPDATE snips SET kind = ?, kind_confident = ?, kind_reason = ?, kind_source = 'inferred' WHERE id = ?`
  );
  let auto = 0,
    manual = 0,
    unsure = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const v = classifySnip(r);
      update.run(v.kind, v.confident ? 1 : 0, v.reason, r.id);
      if (v.kind === "auto") auto++;
      else manual++;
      if (!v.confident) unsure++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { auto, manual, unsure };
}

/** A user's own call always wins, and survives every future re-classification. */
export function setSnipKind(db: DatabaseSync, snipId: string, kind: SnipKind | null): void {
  if (kind === null) {
    db.prepare(`UPDATE snips SET kind_source = 'inferred' WHERE id = ?`).run(snipId);
    const row = db.prepare(`SELECT summary_md, quote_text FROM snips WHERE id = ?`).get(snipId) as
      | KindInput
      | undefined;
    if (row) {
      const v = classifySnip(row);
      db.prepare(`UPDATE snips SET kind = ?, kind_confident = ?, kind_reason = ? WHERE id = ?`).run(
        v.kind,
        v.confident ? 1 : 0,
        v.reason,
        snipId
      );
    }
    return;
  }
  db.prepare(
    `UPDATE snips SET kind = ?, kind_source = 'user', kind_confident = 1, kind_reason = 'you set this' WHERE id = ?`
  ).run(kind, snipId);
}

export interface KindStats {
  auto: number;
  manual: number;
  unsure: number;
  overridden: number;
}

export function kindStats(db: DatabaseSync): KindStats {
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    auto: one(`SELECT COUNT(*) c FROM snips WHERE kind = 'auto'`),
    manual: one(`SELECT COUNT(*) c FROM snips WHERE kind = 'manual'`),
    unsure: one(`SELECT COUNT(*) c FROM snips WHERE kind_confident = 0`),
    overridden: one(`SELECT COUNT(*) c FROM snips WHERE kind_source = 'user'`),
  };
}

/** The snips the classifier is least sure about, for a human to settle. */
export function unsureSnips(db: DatabaseSync, limit = 100): unknown[] {
  return db
    .prepare(
      `SELECT s.id, s.title, s.kind, s.kind_reason AS kindReason,
              s.start_sec AS startSec, s.end_sec AS endSec,
              e.title AS episodeTitle, e.id AS episodeId, sh.title AS showTitle,
              LENGTH(COALESCE(s.summary_md,'')) AS noteChars
       FROM snips s
       JOIN episodes e ON e.id = s.episode_id
       JOIN shows sh ON sh.id = e.show_id
       WHERE s.kind_confident = 0 AND s.kind_source IS NOT 'user'
       ORDER BY noteChars DESC, s.id
       LIMIT ?`
    )
    .all(limit) as unknown[];
}
