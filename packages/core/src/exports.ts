import type { DatabaseSync } from "node:sqlite";
import { bookmarksTimeline, snipdFavoritesTimeline, type TimelineEntry } from "./favorites.ts";
import type { SearchHit } from "./search.ts";
import { getTag, tagSnips } from "./tags.ts";

function clock(sec: number | null): string {
  if (sec === null) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Obsidian-friendly Markdown for one snip-like record (§4.10 copy-as-Markdown shape). */
export function snipToMarkdown(hit: {
  title: string | null;
  quoteText: string | null;
  quoteAttribution: string | null;
  summaryMd: string | null;
  startSec: number | null;
  endSec: number | null;
  shareUrl: string | null;
  episodeTitle: string;
  showTitle: string;
  lastSnipDate: string | null;
  tags?: string[];
}): string {
  const lines: string[] = [];
  const time = hit.startSec !== null ? ` (${clock(hit.startSec)}–${clock(hit.endSec)})` : "";
  const tags = hit.tags?.length ? ` ${hit.tags.map((t) => `#${t.replace(/\s+/g, "-")}`).join(" ")}` : "";
  lines.push(`### ${hit.title ?? "(untitled snip)"}${time}${tags}`);
  lines.push(`*${hit.showTitle} — ${hit.episodeTitle}${hit.lastSnipDate ? ` · ${hit.lastSnipDate}` : ""}*`);
  if (hit.summaryMd) lines.push("", hit.summaryMd);
  if (hit.quoteText) {
    lines.push("", `> ${hit.quoteText.replace(/\n/g, "\n> ")}`);
    if (hit.quoteAttribution) lines.push(`> — ${hit.quoteAttribution}`);
  }
  if (hit.shareUrl) lines.push("", `[Play in Snipd](${hit.shareUrl})`);
  return lines.join("\n");
}

function entryToMarkdown(e: TimelineEntry, icon: string): string[] {
  const out: string[] = [];
  if (e.type === "snip") {
    const tags = e.tags.length ? ` ${e.tags.map((t) => `#${t.replace(/\s+/g, "-")}`).join(" ")}` : "";
    out.push(`### ${icon} ${e.title}${e.startSec !== null ? ` (${clock(e.startSec)})` : ""}${tags}`);
    out.push(`*${e.subtitle}${e.date ? ` · ${e.date}` : ""}*`);
    if (e.quoteText) out.push("", `> ${e.quoteText.replace(/\n/g, "\n> ")}`);
    if (e.shareUrl) out.push("", `[Play in Snipd](${e.shareUrl})`);
  } else {
    out.push(`### ${icon} ${e.type === "show" ? "Show" : "Episode"}: ${e.title}`);
    out.push(`*${e.subtitle}${e.date ? ` · ${e.date}` : ""}*`);
    if (e.shareUrl) out.push("", `[Open in Snipd](${e.shareUrl})`);
  }
  out.push("");
  return out;
}

/** Snipd ⭐ favorites and in-app 🔖 bookmarks, chronological, as one document. */
export function favoritesToMarkdown(db: DatabaseSync): string {
  const out: string[] = ["# Starred", "", "## ⭐ Snipd favorites", ""];
  for (const e of snipdFavoritesTimeline(db, { order: "asc" })) out.push(...entryToMarkdown(e, "⭐"));
  out.push("## 🔖 Bookmarks", "");
  for (const e of bookmarksTimeline(db, { order: "asc" })) out.push(...entryToMarkdown(e, "🔖"));
  return out.join("\n");
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function searchHitsToCsv(hits: SearchHit[]): string {
  const header = ["show", "episode", "date", "start", "end", "title", "tags", "quote", "summary", "snipd_url"];
  const rows = hits.map((h) =>
    [
      h.showTitle,
      h.episodeTitle,
      h.lastSnipDate,
      clock(h.startSec),
      clock(h.endSec),
      h.title,
      h.tags.join("; "),
      h.quoteText,
      h.summaryMd,
      h.shareUrl,
    ]
      .map(csvEscape)
      .join(",")
  );
  return [header.join(","), ...rows].join("\n");
}

export function searchHitsToMarkdown(hits: SearchHit[], query: string): string {
  const out = [`# Search: ${query}`, `*${hits.length} results*`, ""];
  for (const h of hits) out.push(snipToMarkdown(h), "", "---", "");
  return out.join("\n");
}

/** Everything carrying one Snipd tag, oldest first, as a single document. */
export function tagToMarkdown(db: DatabaseSync, key: string): string {
  const tag = getTag(db, key);
  const { snips, total } = tagSnips(db, key, { order: "asc", limit: 5000 });
  const out = [
    `# #${tag?.label ?? key}`,
    `*${total} snips tagged in Snipd${tag?.firstDate ? ` · ${tag.firstDate} – ${tag.lastDate}` : ""}*`,
    "",
  ];
  for (const s of snips) out.push(snipToMarkdown(s), "", "---", "");
  return out.join("\n");
}
