import matter from "gray-matter";
import { createHash } from "node:crypto";
import type { ParsedBook, ParsedEpisode, ParsedPerson, ParsedSnip } from "./types.ts";

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/**
 * Bump when parsing behavior changes: makes the importer re-parse files whose
 * content hash is unchanged but whose previous parse used older logic.
 */
export const PARSER_VERSION = 3;

/** CP1252's 27 characters above U+00FF, mapped back to their single bytes. */
const CP1252_REVERSE: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85,
  "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a,
  "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92,
  "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c,
  "ž": 0x9e, "Ÿ": 0x9f,
};

/**
 * Some vault files are double-encoded (UTF-8 bytes mis-decoded as CP1252 and
 * re-saved as UTF-8), turning 🎧 into "ðŸŽ§". The "ð" + Ÿ pair never occurs in
 * healthy text; when seen, reversing the CP1252 decode restores the original.
 * Aborts (returns input) if any character can't be mapped back to a byte.
 */
function repairMojibake(raw: string): { text: string; repaired: boolean } {
  if (!/ð[Ÿ]/.test(raw)) return { text: raw, repaired: false };
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0xff) bytes[i] = code;
    else {
      const mapped = CP1252_REVERSE[raw[i]];
      if (mapped === undefined) return { text: raw, repaired: false };
      bytes[i] = mapped;
    }
  }
  return { text: Buffer.from(bytes).toString("utf8"), repaired: true };
}

/**
 * Fallback when frontmatter YAML is invalid (real-world example: unquoted
 * `show_author: @Handle`). Line-based `key: value` parse with simple list support.
 */
function lenientFrontmatter(raw: string): { data: Record<string, unknown>; content: string } | null {
  const m = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const data: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      (data[listKey] as unknown[]).push(item[1].replace(/^["']|["']$/g, ""));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    if (rawVal === "") {
      data[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;
    let val: unknown = rawVal.replace(/^["']|["']$/g, "");
    if (/^\d+$/.test(rawVal)) val = Number(rawVal);
    if (rawVal === "true") val = true;
    if (rawVal === "false") val = false;
    data[key] = val;
  }
  return { data, content: m[2] };
}

export function sha1(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

function uuidFromUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = url.match(UUID_RE);
  return m ? m[0].toLowerCase() : null;
}

/** "03:12" -> 192, "01:10:50" -> 4250. Returns null on anything unparseable. */
export function parseClock(text: string | null | undefined): number | null {
  if (!text) return null;
  const parts = text.trim().split(":").map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/** YAML may give a Date (unquoted dates) or a string. Normalize to YYYY-MM-DD. */
function toDateStr(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "string") {
    const m = v.match(/\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : null;
  }
  return null;
}

function toStr(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Extract [label](url) pairs from a line. */
function markdownLinks(line: string): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push({ label: m[1].trim(), url: m[2].trim() });
  return out;
}

interface SnipBlock {
  headingLine: string;
  body: string;
}

/**
 * A `###` line starts a new snip only if it links to a snip share URL, or is a
 * plain heading followed shortly by a 🎧 time line or player iframe. AI notes
 * inside a snip can themselves contain `###` outline headings ("### 1. Title,
 * speaker, guests") — those must stay part of the current snip's body.
 */
function isSnipBoundary(lines: string[], i: number): boolean {
  const line = lines[i];
  if (!/^###\s+\S/.test(line) || /^####/.test(line)) return false;
  if (/share\.snipd\.com\/snip\//.test(line)) return true;
  for (let j = i + 1; j <= Math.min(i + 8, lines.length - 1); j++) {
    if (/^#{1,3}\s/.test(lines[j])) break;
    if (/🎧|obsidian-player\/snip\//.test(lines[j])) return true;
  }
  return false;
}

/** Split the "## Snips" region into blocks, one per snip heading. */
function splitSnipBlocks(body: string): SnipBlock[] {
  const lines = body.split(/\r?\n/);
  const blocks: SnipBlock[] = [];
  let current: string[] | null = null;
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+\S/.test(line) && !/^###/.test(line) && !/^##\s+Snips\s*$/.test(line)) {
      // A different H2 section ends the snips region.
      if (current) blocks.push({ headingLine: heading, body: current.join("\n") });
      current = null;
      continue;
    }
    if (isSnipBoundary(lines, i)) {
      if (current) blocks.push({ headingLine: heading, body: current.join("\n") });
      heading = line;
      current = [];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) blocks.push({ headingLine: heading, body: current.join("\n") });
  return blocks;
}

function parseSnipBlock(block: SnipBlock, episodeId: string, ord: number, warnings: string[]): ParsedSnip {
  let headingText = block.headingLine.replace(/^###\s+/, "").trim();

  // Default template heading: `### {{snip_favorite_star}} [{{snip_title}}]({{snip_url}}) {{snip_tags}}`
  // — a Snipd-app favorite renders as `### ⭐ [Title](url)`; tags render as [[tag]] wiki-links.
  const favorited = /^[⭐★]/.test(headingText);
  headingText = headingText.replace(/^[⭐★]️?\s*/, "");
  const tags: string[] = [];
  const tagRe = /\[\[([^\]]+)\]\]|(?:^|\s)#([\w-]+)/g;
  let tm: RegExpExecArray | null;
  while ((tm = tagRe.exec(headingText)) !== null) tags.push((tm[1] ?? tm[2]).trim());
  headingText = headingText.replace(/\[\[[^\]]+\]\]/g, "").trim();

  let title = headingText;
  let shareUrl: string | null = null;
  const link = markdownLinks(headingText)[0];
  if (link) {
    title = link.label;
    shareUrl = link.url;
  }

  const body = block.body;

  // 🎧 03:12 - 05:18 (02:05)
  let startSec: number | null = null;
  let endSec: number | null = null;
  let durationSec: number | null = null;
  const timeM = body.match(/🎧\s*([\d:]+)\s*[-–]\s*([\d:]+)(?:\s*\(([\d:]+)\))?/);
  if (timeM) {
    startSec = parseClock(timeM[1]);
    endSec = parseClock(timeM[2]);
    durationSec = parseClock(timeM[3]) ?? (startSec !== null && endSec !== null ? endSec - startSec : null);
  } else {
    warnings.push(`snip "${title}": no 🎧 time range found`);
  }

  // Optional Created: line (only present with customized snip templates).
  const createdM = body.match(/^>?\s*Created(?:\s+at)?:\s*(\d{4}-\d{2}-\d{2})/im);
  const createdDate = createdM ? createdM[1] : null;

  // Section boundaries: quote and transcript are H4 sections; tolerate missing emoji.
  const quoteM = body.match(/^####\s*(?:💬\s*)?Quote\s*$/im);
  const transcriptM = body.match(/^####\s*(?:📚\s*)?Transcript\s*$/im);

  const preSectionEnd = Math.min(
    quoteM?.index ?? Number.POSITIVE_INFINITY,
    transcriptM?.index ?? Number.POSITIVE_INFINITY,
    body.length
  );

  // Summary/notes = EVERYTHING before the first H4 section, minus mechanical noise
  // (time line, embed player, Created line, separators). AI notes are often prose
  // paragraphs or bold "**2. Main Theme**" sections, not just bullets — a
  // bullets-only filter silently dropped those (real bug found in the wild).
  const summaryMd =
    body
      .slice(0, preSectionEnd)
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
      .replace(/^.*🎧.*$/m, "")
      .replace(/^>?\s*Created(?:\s+at)?:.*$/gim, "")
      .replace(/^---\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim() || null;

  // Quote section: blockquote lines; attribution is a "— Name" blockquote line; caption is prose after.
  let quoteText: string | null = null;
  let quoteAttribution: string | null = null;
  let quoteCaption: string | null = null;
  if (quoteM && quoteM.index !== undefined) {
    const qEnd = transcriptM && transcriptM.index! > quoteM.index ? transcriptM.index! : body.length;
    const qRegion = body.slice(quoteM.index, qEnd).split(/\r?\n/).slice(1);
    const quoteLines: string[] = [];
    const captionLines: string[] = [];
    for (const raw of qRegion) {
      const line = raw.trim();
      if (line.startsWith(">")) {
        const inner = line.replace(/^>\s?/, "").trim();
        if (/^[—–-]\s*\S/.test(inner) && inner.length < 120) {
          quoteAttribution = inner.replace(/^[—–-]\s*/, "").trim();
        } else if (inner !== "") {
          quoteLines.push(inner);
        }
      } else if (line !== "" && line !== "---") {
        captionLines.push(line);
      }
    }
    quoteText = quoteLines.length > 0 ? quoteLines.join("\n") : null;
    quoteCaption = captionLines.length > 0 ? captionLines.join("\n") : null;
  }

  // Transcript: everything after the H4 until a trailing `---` separator.
  let transcriptMd: string | null = null;
  if (transcriptM && transcriptM.index !== undefined) {
    let region = body.slice(transcriptM.index).split(/\r?\n/).slice(1).join("\n");
    region = region.replace(/\n---\s*$/m, "").trim();
    transcriptMd = region !== "" ? region : null;
  }

  const id = uuidFromUrl(shareUrl) ?? sha1(`${episodeId}|${startSec ?? ord}|${title}`);
  if (!shareUrl) warnings.push(`snip "${title}": no share URL, using derived id`);

  return {
    id,
    title,
    shareUrl,
    startSec,
    endSec,
    durationSec,
    summaryMd,
    quoteText,
    quoteAttribution,
    quoteCaption,
    transcriptMd,
    createdDate,
    favorited,
    tags,
    ord,
  };
}

/**
 * Parse one Snipd episode Markdown file. Never throws on malformed *content*
 * (collects warnings instead); throws only if the frontmatter YAML itself is invalid,
 * which callers treat as a skipped file.
 */
export function parseEpisodeFile(rawInput: string, filePath: string): ParsedEpisode {
  const warnings: string[] = [];
  const { text: raw, repaired } = repairMojibake(rawInput);
  if (repaired) warnings.push("repaired double-encoded UTF-8 content");

  // Pass explicit options: gray-matter's default path caches the file object
  // *before* YAML parsing, so a malformed file that throws once would silently
  // "succeed" with empty frontmatter on the next parse of identical content.
  let fm: Record<string, unknown>;
  let body: string;
  try {
    ({ data: fm, content: body } = matter(raw, {}));
  } catch (err) {
    const lenient = lenientFrontmatter(raw);
    if (!lenient) throw err;
    ({ data: fm, content: body } = lenient);
    warnings.push(`frontmatter YAML invalid (${(err as Error).message.split("\n")[0]}); used lenient parser`);
  }

  const folderName = filePath.split(/[\\/]/).slice(-2, -1)[0] ?? null;
  const fileName = filePath.replace(/^.*[\\/]/, "").replace(/\.md$/, "");

  // Unquoted values starting with `#` (e.g. `show_title: #STRask`) are YAML
  // comments → null. Recover from the body's metadata bullets, then the path.
  const bodyShowM = raw.match(/^- Show:\s*(.+)$/m);
  const showTitle = toStr(fm.show_title) ?? bodyShowM?.[1]?.trim() ?? folderName ?? "Unknown show";
  if (!toStr(fm.show_title))
    warnings.push(`show_title missing in frontmatter; recovered "${showTitle}"`);
  const showUrl = toStr(fm.show_url);
  const showId = uuidFromUrl(showUrl) ?? sha1(`show|${showTitle}`);

  const bodyTitleM = raw.match(/^- Episode title:\s*(.+)$/m);
  const title = toStr(fm.episode_title) ?? bodyTitleM?.[1]?.trim() ?? fileName;
  if (!toStr(fm.episode_title))
    warnings.push(`episode_title missing in frontmatter; recovered "${title}"`);
  const url = toStr(fm.episode_url);
  const publishDate = toDateStr(fm.episode_publish_date);
  const id = uuidFromUrl(url) ?? sha1(`episode|${showTitle}|${title}|${publishDate ?? ""}`);
  if (!url) warnings.push("no episode share URL, using derived id");

  // Prefer the body's precise "- Duration: 01:10:50" over frontmatter whole minutes.
  const durBodyM = body.match(/^- Duration:\s*([\d:]+)\s*$/m);
  const durationSec =
    parseClock(durBodyM?.[1]) ??
    (typeof fm.episode_duration_minutes === "number" ? fm.episode_duration_minutes * 60 : null);

  const aiDescM = body.match(/^- Episode AI description:\s*(.+)$/m);

  const guests: ParsedPerson[] = [];
  const guestsLineM = body.match(/^- Guests?:\s*(.+)$/m);
  const guestLinks = guestsLineM ? markdownLinks(guestsLineM[1]) : [];
  if (guestLinks.length > 0) {
    for (const g of guestLinks) {
      guests.push({ id: uuidFromUrl(g.url) ?? sha1(`person|${g.label}`), name: g.label, url: g.url });
    }
  } else if (Array.isArray(fm.guests)) {
    for (const name of fm.guests) {
      if (typeof name === "string") guests.push({ id: sha1(`person|${name}`), name, url: null });
    }
  }

  const books: ParsedBook[] = [];
  const booksLineM = body.match(/^- Mentioned books:\s*(.+)$/m);
  if (booksLineM) {
    // Format: [Title](url) by [Author](url), [Title2](url) …  — authors follow their book.
    const segs = booksLineM[1].split(/,(?![^[]*\])/); // split on commas outside link labels
    for (const seg of segs) {
      const links = markdownLinks(seg);
      const bookLink = links.find((l) => l.url.includes("/book/"));
      if (!bookLink) continue;
      const authorLink = links.find((l) => l.url.includes("/person/"));
      books.push({
        id: uuidFromUrl(bookLink.url) ?? sha1(`book|${bookLink.label}`),
        title: bookLink.label,
        author: authorLink?.label ?? null,
        url: bookLink.url,
      });
    }
  } else if (Array.isArray(fm.mentioned_books)) {
    for (const t of fm.mentioned_books) {
      if (typeof t === "string") books.push({ id: sha1(`book|${t}`), title: t, author: null, url: null });
    }
  }

  const blocks = splitSnipBlocks(body);
  const snips: ParsedSnip[] = blocks.map((b, i) => parseSnipBlock(b, id, i, warnings));
  if (snips.length === 0) warnings.push("no snips found in file");

  // Deduplicate snip ids within the file (append-mode can duplicate blocks).
  const seen = new Set<string>();
  const deduped = snips.filter((s) => {
    if (seen.has(s.id)) {
      warnings.push(`duplicate snip block "${s.title}" ignored`);
      return false;
    }
    seen.add(s.id);
    return true;
  });

  return {
    id,
    showId,
    showTitle,
    showAuthor: toStr(fm.show_author),
    showUrl,
    showImageUrl: toStr(fm.show_image_url),
    title,
    publishDate,
    lastSnipDate: toDateStr(fm.last_snip_date),
    durationSec,
    exportDate: toStr(fm.episode_export_date),
    aiDescription: aiDescM ? aiDescM[1].trim() : null,
    url,
    imageUrl: toStr(fm.image_url),
    guests,
    books,
    snips: deduped,
    warnings,
  };
}
