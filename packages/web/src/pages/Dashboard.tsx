import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type ActivityBucket,
  type CalendarDay,
  type Overview,
  type Period,
  type RecentItem,
  type ShowStatsRow,
  type TagCount,
} from "../api.ts";
import ActivityChart from "../components/ActivityChart.tsx";
import CalendarHeatmap from "../components/CalendarHeatmap.tsx";
import MeaningIndex from "../components/MeaningIndex.tsx";
import BackupPanel from "../components/BackupPanel.tsx";
import SnipKindPanel from "../components/SnipKindPanel.tsx";
import ShowTable from "../components/ShowTable.tsx";
import TagChip from "../components/TagChip.tsx";
import { delta, fmtDate, fmtHours } from "../format.ts";

const PERIODS: { key: Period; label: string }[] = [
  { key: "week", label: "Past week" },
  { key: "month", label: "Past month" },
  { key: "year", label: "Past year" },
  { key: "all", label: "All time" },
];

function Tile({
  label,
  value,
  d,
  hint,
}: {
  label: string;
  value: string;
  d?: number | null;
  hint?: string;
}) {
  return (
    <div className="card p-4" title={hint}>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="mt-1 flex items-baseline gap-2 text-xs">
        <span className="ink-2">{label}</span>
        {d !== undefined && d !== null && (
          <span style={{ color: d >= 0 ? "var(--delta-up)" : "var(--ink-2)" }}>
            {d >= 0 ? "▲" : "▼"} {Math.abs(d)}%
          </span>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [period, setPeriod] = useState<Period>("month");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [shows, setShows] = useState<ShowStatsRow[]>([]);
  const [activity, setActivity] = useState<ActivityBucket[]>([]);
  const [calendar, setCalendar] = useState<CalendarDay[]>([]);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const year = new Date().getFullYear();

  const bucket: "day" | "week" = period === "all" || period === "year" ? "week" : "day";
  const load = useCallback(() => {
    api<Overview>(`/api/stats/overview?period=${period}`).then(setOverview);
    api<ShowStatsRow[]>(`/api/stats/shows?period=${period}`).then(setShows);
    api<ActivityBucket[]>(`/api/stats/activity?period=${period}&bucket=${bucket}`).then(setActivity);
    api<CalendarDay[]>(`/api/stats/calendar?year=${year}`).then(setCalendar);
    api<RecentItem[]>("/api/recent?limit=8").then(setRecent);
    api<TagCount[]>(`/api/stats/tags?period=${period}&limit=12`).then(setTags);
  }, [period, year]);

  useEffect(load, [load]);
  useEffect(() => {
    window.addEventListener("resurface:synced", load);
    return () => window.removeEventListener("resurface:synced", load);
  }, [load]);

  const o = overview;
  return (
    <div className="space-y-4">
      {/* Every page needs exactly one h1; this one had none, so screen-reader
          users landed on a page that never said what it was. */}
      <h1 className="text-lg font-semibold">Dashboard</h1>
      <div className="flex flex-wrap items-center gap-1">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            className={`rounded-md px-3 py-1.5 text-sm ${period === p.key ? "font-semibold" : "ink-2"}`}
            style={period === p.key ? { background: "var(--series-1-soft)" } : {}}
          >
            {p.label}
          </button>
        ))}
        {o?.from && (
          <span className="ml-2 text-xs muted">
            {fmtDate(o.from)} – {fmtDate(o.to)} · compared with the previous {PERIODS.find((p) => p.key === period)?.label.replace("Past ", "")}
          </span>
        )}
      </div>

      {o && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Episodes snipped" value={String(o.episodes)} d={delta(o.episodes, o.previous?.episodes)} />
          <Tile label="Snips" value={String(o.snips)} d={delta(o.snips, o.previous?.snips)} />
          <Tile label="Shows" value={String(o.shows)} />
          <Tile
            label="Listening time"
            value={fmtHours(o.estimatedSec)}
            d={delta(o.estimatedSec, o.previous?.estimatedSec)}
            hint="Counts the full length of every episode you snipped. If you didn't finish one, this overcounts — Snipd's export contains no playback history."
          />
          <Tile
            label="Snip time"
            value={fmtHours(o.snipSec)}
            d={delta(o.snipSec, o.previous?.snipSec)}
            hint="Total audio captured by your snips; overlapping snips counted once. A capture metric, not a listening bound."
          />
          <Tile
            label="Day streak"
            value={String(o.streak.current)}
            hint={`Best ever: ${o.streak.best} days. Days are counted by each episode's latest snip date.`}
          />
        </div>
      )}

      <ActivityChart data={activity} bucket={bucket} />

      <CalendarHeatmap year={year} days={calendar} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ShowTable rows={shows} />
        </div>
        <div className="space-y-4">
          <MeaningIndex />
          <SnipKindPanel />
          <BackupPanel />
          {tags.length > 0 && (
            <div className="card p-4">
              <h2 className="mb-3 text-sm font-semibold">
                Top tags <span className="muted font-normal">· from Snipd</span>
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <TagChip key={t.key} label={t.label} count={t.count} />
                ))}
              </div>
              <Link to="/tags" className="link mt-3 inline-block text-xs">
                All tags →
              </Link>
            </div>
          )}
          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold">Recently snipped</h2>
            <ul className="space-y-2 text-sm">
              {recent.map((r) => (
                <li key={r.id}>
                  <Link to={`/episodes/${r.id}`} className="link block truncate">
                    {r.title}
                  </Link>
                  <span className="muted text-xs">
                    {r.showTitle} · {r.snips} snips · {fmtDate(r.lastSnipDate)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <p className="text-xs muted">
        The Snipd export has no playback history, so <strong>listening time</strong> counts the full length of every
        episode you snipped (it overcounts episodes you didn't finish), while <strong>snip time</strong> counts only the
        audio your snips captured. Dates are each episode's latest snip date.
      </p>
    </div>
  );
}
