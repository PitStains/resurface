import type { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Packing a library for NotebookLM.
 *
 * NotebookLM has no API for the consumer product — sources are added by hand in
 * the browser — so the useful thing this can do is produce a folder whose files
 * are already the right shape, the right size, and named so that a citation
 * means something. Two limits set the shape (verified against Google's own help
 * pages, 2026-07): **500,000 words or 200 MB per source**, and a cap on
 * **sources per notebook** — 50 free, 300 on Pro, 600 on Ultra.
 *
 * The second limit is the one that bites: a 33k-snip library is far too much
 * for one file and far too many for one-file-per-snip. So snips are grouped
 * into a few hundred files at most, and a group too big for one file is split
 * into numbered parts rather than truncated.
 *
 * Grouping is not cosmetic. NotebookLM answers cite the *source*, so a file per
 * show means an answer says which show it came from; a file per topic means it
 * says which topic. Splitting purely by size produces citations that say
 * nothing.
 */

export type PackGroup = "show" | "category" | "flat";
export type PackInclude = "notes" | "full";
export type PackScope = "all" | "starred" | "manual" | "auto";

export interface PackOptions {
  group?: PackGroup;
  /** "full" adds the transcript, which is roughly 2.5x the words. */
  include?: PackInclude;
  /** Words per file. Kept under NotebookLM's 500,000 with room to spare. */
  maxWords?: number;
  scope?: PackScope;
}

export interface PlannedFile {
  name: string;
  group: string;
  part: number;
  parts: number;
  snips: number;
  words: number;
}

export interface PackPlan {
  files: PlannedFile[];
  totalSnips: number;
  totalWords: number;
  /** Which plans this many sources fits inside. */
  fits: { free: boolean; pro: boolean; ultra: boolean };
  notes: string[];
  options: Required<PackOptions>;
}

/** Google's published caps, so the UI can say "this fits" rather than guess. */
export const SOURCE_LIMITS = { free: 50, pro: 300, ultra: 600 } as const;
export const WORDS_PER_SOURCE = 500_000;

const DEFAULTS: Required<PackOptions> = {
  group: "show",
  include: "notes",
  // 400k leaves ~20% headroom: NotebookLM counts words its own way, and being
  // rejected after a long upload is a worse failure than one extra file.
  maxWords: 400_000,
  scope: "all",
};

export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

interface Row {
  id: string;
  title: string | null;
  summaryMd: string | null;
  quoteText: string | null;
  quoteAttribution: string | null;
  transcriptMd: string | null;
  startSec: number | null;
  endSec: number | null;
  shareUrl: string | null;
  date: string | null;
  episodeTitle: string;
  showTitle: string;
  kind: string | null;
  favorited: number;
  tagsJson: string | null;
  groupName: string;
}

function clock(sec: number | null): string {
  if (sec === null) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h > 0 ? `${h}:` : ""}${String(m).padStart(h > 0 ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

function fetchRows(db: DatabaseSync, opts: Required<PackOptions>): Row[] {
  const where: string[] = [];
  if (opts.scope === "starred") where.push("s.favorited = 1");
  if (opts.scope === "manual") where.push("s.kind = 'manual'");
  if (opts.scope === "auto") where.push("s.kind = 'auto'");

  // One category per snip — the best-scoring one. A snip in three categories
  // would otherwise be exported three times, inflating every count.
  const groupExpr =
    opts.group === "show"
      ? "sh.title"
      : opts.group === "category"
        ? `COALESCE((SELECT c.name FROM category_snips cs JOIN categories c ON c.id = cs.category_id
                      WHERE cs.snip_id = s.id ORDER BY cs.manual DESC, cs.score DESC LIMIT 1), 'Uncategorised')`
        : "''";

  const order =
    opts.group === "flat"
      ? "e.last_snip_date, e.id, s.ord"
      : "groupName, e.last_snip_date, e.id, s.ord";

  return db
    .prepare(
      `SELECT s.id, s.title, s.summary_md AS summaryMd, s.quote_text AS quoteText,
              s.quote_attribution AS quoteAttribution, s.transcript_md AS transcriptMd,
              s.start_sec AS startSec, s.end_sec AS endSec, s.share_url AS shareUrl,
              e.last_snip_date AS date, e.title AS episodeTitle, sh.title AS showTitle,
              s.kind, s.favorited, s.tags_json AS tagsJson,
              ${groupExpr} AS groupName
         FROM snips s
         JOIN episodes e ON e.id = s.episode_id
         JOIN shows sh ON sh.id = e.show_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY ${order}`
    )
    .all() as unknown as Row[];
}

function renderSnip(r: Row, include: PackInclude): string {
  // "##" for the snip, so the "###" headings inside a hand-written note stay
  // subordinate to it rather than competing with it.
  const time = r.startSec !== null ? ` · ${clock(r.startSec)}–${clock(r.endSec)}` : "";
  const out: string[] = [`## ${r.title ?? "(untitled snip)"}`];
  out.push(`*${r.showTitle} — ${r.episodeTitle}${r.date ? ` · ${r.date}` : ""}${time}*`);

  let tags: string[] = [];
  try {
    tags = r.tagsJson ? (JSON.parse(r.tagsJson) as string[]) : [];
  } catch {
    tags = [];
  }
  const marks = [
    r.favorited ? "starred in Snipd" : null,
    r.kind === "manual" ? "saved by hand" : null,
    tags.length ? `tags: ${tags.join(", ")}` : null,
  ].filter(Boolean);
  if (marks.length) out.push(`*(${marks.join(" · ")})*`);

  if (r.summaryMd) out.push("", r.summaryMd.trim());
  if (r.quoteText) {
    out.push("", `> ${r.quoteText.trim().replace(/\n/g, "\n> ")}`);
    if (r.quoteAttribution) out.push(`>`, `> — ${r.quoteAttribution}`);
  }
  if (include === "full" && r.transcriptMd) {
    out.push("", "### Transcript", "", r.transcriptMd.trim());
  }
  if (r.shareUrl) out.push("", `[Listen in Snipd](${r.shareUrl})`);
  out.push("", "---");
  return out.join("\n");
}

interface Bin {
  group: string;
  bodies: string[];
  words: number;
  first: string | null;
  last: string | null;
}

/**
 * Fill files in reading order, starting a new one when the next snip would
 * cross the limit. A single snip larger than the limit still gets its own file:
 * splitting one note across two sources would break the thing NotebookLM is
 * best at, which is quoting a passage whole.
 */
function pack(rows: Row[], opts: Required<PackOptions>): Bin[] {
  const bins: Bin[] = [];
  let bin: Bin | null = null;
  let currentGroup: string | null = null;

  for (const r of rows) {
    const body = renderSnip(r, opts.include);
    const w = countWords(body);
    const groupChanged = opts.group !== "flat" && r.groupName !== currentGroup;
    if (!bin || groupChanged || (bin.words > 0 && bin.words + w > opts.maxWords)) {
      bin = { group: r.groupName, bodies: [], words: 0, first: r.date, last: r.date };
      bins.push(bin);
      currentGroup = r.groupName;
    }
    bin.bodies.push(body);
    bin.words += w;
    if (r.date) {
      if (!bin.first || r.date < bin.first) bin.first = r.date;
      if (!bin.last || r.date > bin.last) bin.last = r.date;
    }
  }
  return bins;
}

function nameFiles(bins: Bin[], group: PackGroup): PlannedFile[] {
  const partsByGroup = new Map<string, number>();
  for (const b of bins) partsByGroup.set(b.group, (partsByGroup.get(b.group) ?? 0) + 1);

  const seen = new Map<string, number>();
  const pad = String(bins.length).length;
  return bins.map((b, i) => {
    const parts = partsByGroup.get(b.group) ?? 1;
    const part = (seen.get(b.group) ?? 0) + 1;
    seen.set(b.group, part);
    const base =
      group === "flat"
        ? `snips-${b.first ?? "undated"}-to-${b.last ?? "undated"}`
        : slug(b.group);
    const suffix = parts > 1 ? `-part-${part}-of-${parts}` : "";
    return {
      name: `${String(i + 1).padStart(pad, "0")}-${base}${suffix}.md`,
      group: b.group,
      part,
      parts,
      snips: b.bodies.length,
      words: b.words,
    };
  });
}

function planNotes(files: PlannedFile[], opts: Required<PackOptions>, totalWords: number): string[] {
  const notes: string[] = [];
  if (files.length === 0) return ["Nothing matches that choice, so there is nothing to export."];
  const n = files.length + 1; // +1 for the "about" source
  if (n > SOURCE_LIMITS.ultra)
    notes.push(
      `${n} files is more than any plan accepts. Raise the words per file, or narrow what you export.`
    );
  else if (n > SOURCE_LIMITS.pro)
    notes.push(`${n} files needs Ultra (600). Raise the words per file to make fewer of them.`);
  else if (n > SOURCE_LIMITS.free)
    notes.push(`${n} files needs Pro (300 sources); the free plan takes 50.`);

  const over = files.filter((f) => f.words > WORDS_PER_SOURCE);
  if (over.length)
    notes.push(
      `${over.length} file(s) exceed NotebookLM's 500,000-word ceiling because a single snip does. They will be rejected.`
    );
  if (opts.include === "notes" && totalWords > 0)
    notes.push("Transcripts are left out. Turn them on for verbatim detail, at roughly 3.5x the words.");
  if (opts.group === "flat")
    notes.push("Grouped by date only, so answers will cite a date range rather than a show.");
  return notes;
}

function build(db: DatabaseSync, options: PackOptions): { bins: Bin[]; plan: PackPlan } {
  const opts = { ...DEFAULTS, ...options };
  opts.maxWords = Math.min(WORDS_PER_SOURCE, Math.max(10_000, Math.floor(opts.maxWords)));
  const rows = fetchRows(db, opts);
  const bins = pack(rows, opts);
  const files = nameFiles(bins, opts.group);
  const totalWords = files.reduce((a, f) => a + f.words, 0);
  const sources = files.length + 1; // the "about" document is a source too
  return {
    bins,
    plan: {
      files,
      totalSnips: rows.length,
      totalWords,
      fits: {
        free: sources <= SOURCE_LIMITS.free,
        pro: sources <= SOURCE_LIMITS.pro,
        ultra: sources <= SOURCE_LIMITS.ultra,
      },
      notes: planNotes(files, opts, totalWords),
      options: opts,
    },
  };
}

/** What the export would produce, without writing anything. */
export function planPack(db: DatabaseSync, options: PackOptions = {}): PackPlan {
  return build(db, options).plan;
}

const SCOPE_LABEL: Record<PackScope, string> = {
  all: "every snip",
  starred: "snips starred in Snipd",
  manual: "snips saved by hand",
  auto: "snips Snipd saved automatically",
};

/**
 * A source explaining what the other sources are. Without it the model has to
 * infer what a "snip" is, and it guesses badly — it reads the timestamps as
 * publication dates and the quotes as the author's own words.
 */
function aboutDocument(plan: PackPlan, files: PlannedFile[]): string {
  const dates = files.map((f) => f.group);
  return [
    "# About this collection",
    "",
    "These are podcast highlights (\"snips\") saved with the Snipd app and exported by Resurface.",
    "",
    "## What one entry is",
    "",
    "Each `##` heading is a single highlight from a podcast episode. Under it:",
    "",
    "- an italic line naming the **show**, the **episode**, the date, and the timestamp within the episode;",
    "- a written **note** summarising that moment — some are written by the listener, some generated by Snipd;",
    "- a **quote**, in blockquote form, transcribed from the audio;",
    "- a link back to the audio.",
    "",
    "## Reading it correctly",
    "",
    "- The quotes are **spoken words transcribed from audio**, not the listener's writing. Attribute them to the speaker named, or to the show.",
    "- The date is when the episode was last snipped, **not** when the episode was published and not when it was listened to.",
    "- Notes marked *saved by hand* were deliberately captured by the listener; the rest were produced automatically when a snip was triggered. Both are the listener's library, but only the first reflects a deliberate choice.",
    "- \"Starred in Snipd\" marks a highlight the listener singled out.",
    "- Nothing here is a complete episode. These are excerpts, and absence of a subject does not mean it was never discussed.",
    "",
    "## What this export contains",
    "",
    `- ${plan.totalSnips.toLocaleString()} snips (${SCOPE_LABEL[plan.options.scope]}), about ${plan.totalWords.toLocaleString()} words.`,
    `- Split across ${files.length} files, grouped by ${plan.options.group === "flat" ? "date" : plan.options.group}.`,
    `- Transcripts are ${plan.options.include === "full" ? "included" : "not included"}.`,
    plan.options.group === "show"
      ? `- Shows: ${[...new Set(dates)].slice(0, 40).join("; ")}${new Set(dates).size > 40 ? "; …" : ""}`
      : "",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function howToImport(plan: PackPlan, dir: string): string {
  const sources = plan.files.length + 1;
  return [
    "# Importing this into NotebookLM",
    "",
    "**Do not upload this file** — it is instructions, not material. Upload the contents of the",
    "`sources` folder next to it.",
    "",
    "## Steps",
    "",
    "1. Open <https://notebooklm.google.com> and create a notebook.",
    "2. Click **Add source** → **Upload file**.",
    `3. Select **everything inside \`${join(dir, "sources")}\`** — ${sources} Markdown files. You can drag them all in at once.`,
    "4. Wait for each one to finish processing before asking anything; large files take a minute.",
    "",
    "## What to expect",
    "",
    `- **${sources} sources.** NotebookLM allows 50 on the free plan, 300 on Google AI Pro, 600 on Ultra.`,
    `- **~${plan.totalWords.toLocaleString()} words total**, and no single file over ${plan.options.maxWords.toLocaleString()}. NotebookLM's ceiling is 500,000 words per source.`,
    "- Markdown (`.md`) is a supported source type, so headings, quotes and links survive the upload.",
    "",
    "## Getting good answers",
    "",
    "- Upload `00-about-this-collection.md` too. It tells the model that the quotes are transcribed speech rather than the listener's own writing, which it otherwise gets wrong.",
    "- Answers cite the source file they came from, which is why the files are named after "
      + (plan.options.group === "flat" ? "date ranges" : `the ${plan.options.group}`)
      + ".",
    "- Ask about themes across shows, not about totals. This is an excerpt collection: it cannot tell you how much you listened, and \"never mentioned\" only ever means \"not in what was snipped\".",
    "",
    "## Re-exporting",
    "",
    "Run the export again after new snips arrive and upload the new folder into a fresh notebook.",
    "NotebookLM has no consumer API, so there is no way for Resurface to sync into it directly, and",
    "re-uploading a changed file does not replace the old source — it adds a second copy.",
    "",
  ].join("\n");
}

export interface PackResult {
  dir: string;
  sourcesDir: string;
  files: PlannedFile[];
  totalWords: number;
  totalSnips: number;
}

/** Write the pack. Returns where it went, so the UI can open the folder. */
export function writePack(db: DatabaseSync, exportsRoot: string, options: PackOptions = {}): PackResult {
  const { bins, plan } = build(db, options);
  const files = plan.files;
  // A folder holding only instructions is worse than a refusal: it looks like
  // it worked, and the mistake surfaces in NotebookLM instead of here.
  if (plan.totalSnips === 0) throw new Error("Nothing to export — no snips match that choice.");

  // Milliseconds, not minutes: two exports a few seconds apart (notes, then
  // the same thing with transcripts) must not land in the same folder.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  const dir = join(exportsRoot, `notebooklm-${stamp}`);
  const sourcesDir = join(dir, "sources");
  mkdirSync(sourcesDir, { recursive: true });

  files.forEach((f, i) => {
    const bin = bins[i];
    const heading = [
      `# ${f.group || "Snips"}${f.parts > 1 ? ` (part ${f.part} of ${f.parts})` : ""}`,
      "",
      `*${f.snips.toLocaleString()} podcast snips${bin.first ? `, ${bin.first} to ${bin.last}` : ""}. ` +
        `Exported from Snipd via Resurface. See "About this collection" for how to read these.*`,
      "",
      "---",
      "",
    ].join("\n");
    writeFileSync(join(sourcesDir, f.name), heading + bin.bodies.join("\n\n") + "\n", "utf8");
  });

  writeFileSync(join(sourcesDir, "00-about-this-collection.md"), aboutDocument(plan, files), "utf8");
  writeFileSync(join(dir, "HOW-TO-IMPORT.md"), howToImport(plan, dir), "utf8");

  return {
    dir,
    sourcesDir,
    files,
    totalWords: plan.totalWords,
    totalSnips: plan.totalSnips,
  };
}
