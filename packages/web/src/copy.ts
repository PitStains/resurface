import { fmtClock } from "./format.ts";

export interface CopyableSnip {
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
}

/** Obsidian-friendly Markdown — mirrors core's snipToMarkdown shape. */
function snipMarkdown(s: CopyableSnip): string {
  const lines: string[] = [];
  const time = s.startSec !== null ? ` (${fmtClock(s.startSec)}–${fmtClock(s.endSec)})` : "";
  lines.push(`### ${s.title ?? "(untitled snip)"}${time}`);
  lines.push(`*${s.showTitle} — ${s.episodeTitle}${s.lastSnipDate ? ` · ${s.lastSnipDate}` : ""}*`);
  if (s.summaryMd) lines.push("", s.summaryMd);
  if (s.quoteText) {
    lines.push("", `> ${s.quoteText.replace(/\n/g, "\n> ")}`);
    if (s.quoteAttribution) lines.push(`> — ${s.quoteAttribution}`);
  }
  if (s.shareUrl) lines.push("", `[Play in Snipd](${s.shareUrl})`);
  return lines.join("\n");
}

export async function copySnip(s: CopyableSnip): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(snipMarkdown(s));
    return true;
  } catch {
    return false;
  }
}
