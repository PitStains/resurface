export function fmtHours(sec: number): string {
  const h = sec / 3600;
  if (h >= 100) return `${Math.round(h).toLocaleString()} h`;
  if (h >= 10) return `${h.toFixed(1)} h`;
  if (h >= 1) return `${h.toFixed(1)} h`;
  return `${Math.round(sec / 60)} min`;
}

/** Compact duration for table cells: "3 min", "48 min", "1 h 12 m". */
export function fmtDuration(sec: number): string {
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

export function fmtClock(sec: number | null): string {
  if (sec === null) return "–";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtDate(d: string | null): string {
  if (!d) return "–";
  return new Date(d + "T12:00:00").toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function fmtMonth(ym: string): string {
  return new Date(ym + "-15T12:00:00").toLocaleDateString(undefined, { year: "numeric", month: "long" });
}

/** Signed percent delta vs previous, or null when not meaningful. */
export function delta(cur: number, prev: number | undefined | null): number | null {
  if (prev === undefined || prev === null || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}
