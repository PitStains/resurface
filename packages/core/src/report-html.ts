import type { DatabaseSync } from "node:sqlite";
import type { ImportReport } from "./types.ts";

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Standalone import-report HTML (inline CSS, no external assets). */
export function renderImportReport(report: ImportReport, db: DatabaseSync): string {
  const topShows = db
    .prepare(
      `SELECT s.title, COUNT(DISTINCT e.id) episodes, COUNT(sn.id) snips
       FROM shows s
       JOIN episodes e ON e.show_id = s.id AND e.archived = 0
       LEFT JOIN snips sn ON sn.episode_id = e.id AND sn.archived = 0
       GROUP BY s.id ORDER BY snips DESC LIMIT 15`
    )
    .all() as { title: string; episodes: number; snips: number }[];

  const durationMs = new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime();
  const tiles: [string, string | number][] = [
    ["Files seen", report.filesSeen],
    ["Parsed", report.filesParsed],
    ["Unchanged", report.filesUnchanged],
    ["Skipped", report.filesSkipped],
    ["New snips", report.snipsNew],
    ["Updated snips", report.snipsUpdated],
    ["Archived snips", report.snipsArchived],
    ["Run time", `${(durationMs / 1000).toFixed(1)}s`],
  ];

  const warningRows = report.warnings
    .slice(0, 300)
    .map((w) => `<tr><td>${esc(w.file)}</td><td>${esc(w.message)}</td></tr>`)
    .join("\n");
  const showRows = topShows
    .map((s) => `<tr><td>${esc(s.title)}</td><td class="num">${s.episodes}</td><td class="num">${s.snips}</td></tr>`)
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Resurface import report</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: .75rem; }
  .tile { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 10px; padding: .75rem; }
  .tile b { display: block; font-size: 1.4rem; }
  .totals { margin: 1rem 0; font-size: 1.05rem; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  td, th { border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); padding: .35rem .5rem; text-align: left; vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { opacity: .7; }
</style></head><body>
<h1>Resurface — import report</h1>
<p class="muted">Vault: ${esc(report.vaultPath)}<br>Run: ${esc(report.startedAt)} → ${esc(report.finishedAt)}</p>
<p class="totals">Library now holds <b>${report.totals.shows}</b> shows · <b>${report.totals.episodes}</b> episodes · <b>${report.totals.snips}</b> snips${report.episodesArchived ? ` · ${report.episodesArchived} episodes archived` : ""}</p>
<div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><b>${esc(v)}</b>${esc(k)}</div>`).join("")}</div>
<h2>Top shows by snips</h2>
<table><tr><th>Show</th><th class="num">Episodes</th><th class="num">Snips</th></tr>${showRows}</table>
<h2>Warnings (${report.warnings.length}${report.warnings.length > 300 ? ", first 300 shown" : ""})</h2>
${report.warnings.length === 0 ? '<p class="muted">None 🎉</p>' : `<table><tr><th>File</th><th>Message</th></tr>${warningRows}</table>`}
</body></html>`;
}
