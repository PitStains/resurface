import { useMemo, useState } from "react";
import type { CalendarDay } from "../api.ts";
import { fmtDate } from "../format.ts";

const CELL = 12;
const GAP = 3;
const BINS = ["var(--seq-1)", "var(--seq-2)", "var(--seq-3)", "var(--seq-4)", "var(--seq-5)"];

function binFor(snips: number, max: number): string {
  if (max <= 0) return BINS[0];
  const t = snips / max;
  const idx = Math.min(BINS.length - 1, Math.floor(t * BINS.length));
  return BINS[idx];
}

export default function CalendarHeatmap({ year, days }: { year: number; days: CalendarDay[] }) {
  const [hover, setHover] = useState<{ x: number; y: number; day: CalendarDay } | null>(null);
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const max = useMemo(() => Math.max(0, ...days.map((d) => d.snips)), [days]);

  const jan1 = new Date(`${year}-01-01T12:00:00`);
  const startOffset = (jan1.getDay() + 6) % 7; // Monday-start
  const isLeap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const totalDays = isLeap ? 366 : 365;
  const weeks = Math.ceil((totalDays + startOffset) / 7);

  const cells: { x: number; y: number; date: string }[] = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(jan1);
    d.setDate(d.getDate() + i);
    const date = d.toLocaleDateString("sv-SE");
    const idx = i + startOffset;
    cells.push({ x: Math.floor(idx / 7), y: idx % 7, date });
  }
  const monthLabels: { x: number; label: string }[] = [];
  for (let m = 0; m < 12; m++) {
    const first = new Date(year, m, 1, 12);
    const idx = Math.floor((first.getTime() - jan1.getTime()) / 86400000) + startOffset;
    monthLabels.push({ x: Math.floor(idx / 7), label: first.toLocaleDateString(undefined, { month: "short" }) });
  }

  const width = weeks * (CELL + GAP) + 28;
  const height = 7 * (CELL + GAP) + 24;

  return (
    <div className="card relative overflow-x-auto p-4">
      <h2 className="mb-2 text-sm font-semibold">
        {year} calendar <span className="muted font-normal">· snips per day</span>
      </h2>
      <svg width={width} height={height} role="img" aria-label={`Calendar heatmap of snips per day in ${year}`}>
        {monthLabels.map((m) => (
          <text key={m.label} x={28 + m.x * (CELL + GAP)} y={10} fontSize={10} fill="var(--muted)">
            {m.label}
          </text>
        ))}
        {["Mon", "Wed", "Fri"].map((d, i) => (
          <text key={d} x={0} y={24 + (i * 2 + 0.8) * (CELL + GAP)} fontSize={10} fill="var(--muted)">
            {d}
          </text>
        ))}
        {cells.map((c) => {
          const day = byDate.get(c.date);
          return (
            <rect
              key={c.date}
              x={28 + c.x * (CELL + GAP)}
              y={16 + c.y * (CELL + GAP)}
              width={CELL}
              height={CELL}
              rx={3}
              fill={day ? binFor(day.snips, max) : "transparent"}
              stroke={day ? "none" : "var(--grid)"}
              strokeWidth={day ? 0 : 1}
              onMouseEnter={(e) => {
                if (day) {
                  const rect = (e.currentTarget.ownerSVGElement!.parentElement as HTMLElement).getBoundingClientRect();
                  setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, day });
                }
              }}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </svg>
      <div className="mt-2 flex items-center gap-1 text-xs muted">
        Less
        {BINS.map((b) => (
          <span key={b} className="inline-block h-3 w-3 rounded-sm" style={{ background: b }} />
        ))}
        More
      </div>
      {hover && (
        <div
          className="card pointer-events-none absolute z-10 px-3 py-2 text-xs shadow-sm"
          style={{ left: Math.min(hover.x + 12, 600), top: hover.y + 12 }}
        >
          <div className="muted">{fmtDate(hover.day.date)}</div>
          <div className="font-semibold">
            {hover.day.snips} snips · {hover.day.episodes} episodes
          </div>
        </div>
      )}
    </div>
  );
}
