import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ActivityBucket } from "../api.ts";
import { fmtDate, fmtHours } from "../format.ts";

type Metric = "hours" | "episodes" | "snips";
const METRICS: { key: Metric; label: string }[] = [
  { key: "hours", label: "Listening hours" },
  { key: "episodes", label: "Episodes" },
  { key: "snips", label: "Snips" },
];

export default function ActivityChart({ data, bucket }: { data: ActivityBucket[]; bucket: "day" | "week" }) {
  const [metric, setMetric] = useState<Metric>("hours");
  const rows = useMemo(
    () =>
      data.map((d) => ({
        date: d.date,
        value: metric === "hours" ? +(d.estimatedSec / 3600).toFixed(2) : metric === "episodes" ? d.episodes : d.snips,
      })),
    [data, metric]
  );
  const fmtVal = (v: number) => (metric === "hours" ? fmtHours(v * 3600) : String(v));

  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Listening activity <span className="muted font-normal">· {METRICS.find((m) => m.key === metric)!.label} per {bucket}, by snip date</span>
        </h2>
        <div className="flex gap-1">
          {METRICS.map((m) => (
            <button
              key={m.key}
              onClick={() => setMetric(m.key)}
              className={`rounded px-2 py-1 text-xs ${metric === m.key ? "font-semibold" : "ink-2"}`}
              style={metric === m.key ? { background: "var(--series-1-soft)" } : {}}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ width: "100%", height: 220 }}>
        <ResponsiveContainer>
          <AreaChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => fmtDate(d).replace(/, \d{4}$/, "")}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              axisLine={{ stroke: "var(--baseline)" }}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              width={36}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ stroke: "var(--baseline)", strokeWidth: 1 }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <div className="card px-3 py-2 text-xs shadow-sm">
                    <div className="muted">{fmtDate(String(label))}</div>
                    <div className="font-semibold">{fmtVal(payload[0].value as number)}</div>
                  </div>
                ) : null
              }
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="var(--series-1)"
              strokeWidth={2}
              fill="var(--series-1-soft)"
              activeDot={{ r: 4, fill: "var(--series-1)", stroke: "var(--surface-1)", strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
