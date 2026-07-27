import { useState } from "react";
import type { Wrapped } from "../api.ts";
import { fmtHours } from "../format.ts";

/**
 * Wrapped as a shareable image.
 *
 * Built as an SVG string and rasterised through a canvas in the browser, so it
 * needs no rendering library and no server round-trip. Fonts are the generic
 * system stack, because an SVG rasterised this way cannot pull a webfont.
 */
const W = 1080;
const H = 1350;

const esc = (s: string) =>
  s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function buildSvg(w: Wrapped, heading: string): string {
  const rows = w.topShows
    .slice(0, 5)
    .map((s, i) => {
      const y = 690 + i * 88;
      return `
    <text x="90" y="${y}" font-size="34" fill="#0b1220" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-weight="600">${
        i + 1
      }</text>
    <text x="150" y="${y}" font-size="34" fill="#0b1220" font-family="Segoe UI, Helvetica, Arial, sans-serif">${esc(
        clip(s.title, 26)
      )}</text>
    <text x="990" y="${y}" font-size="32" fill="#5b6577" text-anchor="end" font-family="Segoe UI, Helvetica, Arial, sans-serif">${esc(
        fmtHours(s.estimatedSec)
      )}</text>`;
    })
    .join("");

  const stat = (x: number, value: string, label: string) => `
    <text x="${x}" y="1180" font-size="52" fill="#0b1220" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-weight="700">${esc(
    value
  )}</text>
    <text x="${x}" y="1225" font-size="26" fill="#5b6577" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif">${esc(
    label
  )}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#eef2ff"/>
      <stop offset="100%" stop-color="#ffffff"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="60" y="60" width="960" height="1230" rx="36" fill="#ffffff" stroke="#dfe3ec" stroke-width="2"/>

  <text x="90" y="170" font-size="30" fill="#5b6577" font-family="Segoe UI, Helvetica, Arial, sans-serif" letter-spacing="3">RESURFACE</text>
  <text x="90" y="250" font-size="56" fill="#0b1220" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-weight="700">${esc(
    heading
  )}</text>

  <text x="90" y="420" font-size="150" fill="#0b1220" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-weight="800">${esc(
    fmtHours(w.estimatedSec)
  )}</text>
  <text x="90" y="480" font-size="32" fill="#5b6577" font-family="Segoe UI, Helvetica, Arial, sans-serif">of listening across ${w.episodes.toLocaleString()} episodes and ${
    w.shows
  } shows</text>

  <line x1="90" y1="560" x2="990" y2="560" stroke="#dfe3ec" stroke-width="2"/>
  <text x="90" y="620" font-size="30" fill="#5b6577" font-family="Segoe UI, Helvetica, Arial, sans-serif" letter-spacing="2">TOP SHOWS</text>
  ${rows}

  <line x1="90" y1="1090" x2="990" y2="1090" stroke="#dfe3ec" stroke-width="2"/>
  ${stat(240, w.snips.toLocaleString(), "snips")}
  ${stat(540, String(w.longestStreak), "day streak")}
  ${stat(840, w.favorites.toLocaleString(), "favorites")}
</svg>`;
}

export default function WrappedImage({ w, heading }: { w: Wrapped; heading: string }) {
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const svg = buildSvg(w, heading);
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("render failed"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (!png) return;
      const link = document.createElement("a");
      const href = URL.createObjectURL(png);
      link.href = href;
      link.download = `resurface-${heading.toLowerCase().replace(/\s+/g, "-")}.png`;
      link.click();
      // Revoking straight after click() can race the browser's own read of the
      // blob and cancel the download; let it finish first.
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button onClick={() => void save()} disabled={busy} className="card px-3 py-1 text-sm hover:opacity-80">
      {busy ? "Rendering…" : "Save as image"}
    </button>
  );
}
