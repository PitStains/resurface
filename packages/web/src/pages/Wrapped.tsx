import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type Wrapped, type WrappedShow } from "../api.ts";
import TagChip from "../components/TagChip.tsx";
import TopList from "../components/TopList.tsx";
import WrappedImage from "../components/WrappedImage.tsx";
import { delta, fmtClock, fmtDate, fmtDuration, fmtHours, fmtMonth } from "../format.ts";

/** How shows are ranked — hours hide short-form shows, so the lens is explicit. */
const METRICS = [
  { key: "estimatedSec", label: "Hours", hint: "Full length of every episode you snipped" },
  { key: "episodes", label: "Episodes", hint: "Where daily 3-minute shows finally win" },
  { key: "snips", label: "Snips", hint: "Raw number of snips taken" },
  { key: "snipsPerHour", label: "Snips/hr", hint: "Density — structurally favors short episodes" },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type WeekMetric = "snips" | "episodes" | "estimatedSec";

function Card({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="card p-5">
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function Stat({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <div className="card p-5" title={hint}>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="ink-2 mt-1 text-sm">{label}</div>
    </div>
  );
}

const metricValue = (s: WrappedShow, m: MetricKey): number => (s[m] ?? 0) as number;

function metricText(s: WrappedShow, m: MetricKey): string {
  if (m === "estimatedSec") return fmtHours(s.estimatedSec);
  if (m === "episodes") return `${s.episodes} episodes`;
  if (m === "snips") return `${s.snips} snips`;
  return `${s.snipsPerHour ?? 0}/hr`;
}

const rowLink = (to: string, text: string) => (
  <Link to={to} className="min-w-0 flex-1 truncate hover:underline">
    {text}
  </Link>
);
const rowValue = (text: string) => (
  <span className="ink-2 shrink-0 text-xs" style={{ fontVariantNumeric: "tabular-nums" }}>
    {text}
  </span>
);

export default function WrappedPage() {
  const now = new Date();
  const thisYear = now.getFullYear();
  const [year, setYear] = useState(thisYear);
  const [month, setMonth] = useState<number | null>(null);
  const [w, setW] = useState<Wrapped | null>(null);
  const [metric, setMetric] = useState<MetricKey>("estimatedSec");
  // The weekday bars used to be snip counts with nothing saying so.
  const [weekMetric, setWeekMetric] = useState<WeekMetric>("snips");

  useEffect(() => {
    setW(null);
    api<Wrapped>(`/api/stats/wrapped?year=${year}${month ? `&month=${month}` : ""}`).then(setW);
  }, [year, month]);

  const periodPicker = (
    <>
      <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="card px-2 py-1 text-sm">
        {[thisYear, thisYear - 1, thisYear - 2].map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      <select
        value={month ?? ""}
        onChange={(e) => setMonth(e.target.value === "" ? null : Number(e.target.value))}
        className="card px-2 py-1 text-sm"
      >
        <option value="">Whole year</option>
        {MONTHS.map((m, i) => (
          <option key={m} value={i + 1}>
            {m}
          </option>
        ))}
      </select>
    </>
  );

  const heading = month ? `${MONTHS[month - 1]} ${year}` : `${year}`;

  if (!w)
    return (
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">Your year in podcasts</h1>
          {periodPicker}
        </div>
        <p className="muted text-sm">Loading…</p>
      </div>
    );

  const ranked = [...w.topShows].sort((a, b) => metricValue(b, metric) - metricValue(a, metric));
  const days = Math.round(w.estimatedSec / 86400);
  const topShare = w.estimatedSec > 0 ? Math.round(((ranked[0]?.estimatedSec ?? 0) / w.estimatedSec) * 100) : 0;
  const maxMonth = Math.max(1, ...w.months.map((m) => m.episodes));
  const maxWeekday = Math.max(1, ...w.weekdays.map((d) => d[weekMetric]));
  const maxBucket = Math.max(1, ...w.durationBuckets.map((b) => b.episodes));
  const yoy = w.previous ? delta(w.estimatedSec, w.previous.estimatedSec) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{month ? "Your month in podcasts" : "Your year in podcasts"}</h1>
        {periodPicker}
        {w.episodes > 0 && (
          <div className="ml-auto">
            <WrappedImage w={w} heading={heading} />
          </div>
        )}
      </div>

      {w.episodes === 0 ? (
        <Card>
          <p className="muted text-sm">Nothing snipped in {heading} yet.</p>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="card p-5 text-center">
            <div className="text-4xl font-semibold">{fmtHours(w.estimatedSec)}</div>
            <div className="ink-2 mt-1 text-sm">
              of listening in {heading} across {w.episodes.toLocaleString()} episodes and {w.shows} shows
              {w.previous && yoy !== null && (
                <span title={`Same period ${w.previous.year}: ${fmtHours(w.previous.estimatedSec)}`}>
                  {" · "}
                  {yoy >= 0 ? "▲" : "▼"} {Math.abs(yoy)}% vs {w.previous.year}
                </span>
              )}
            </div>
            <div className="muted mt-1 text-xs">
              ≈ {days} days of audio · {w.snips.toLocaleString()} snips · {fmtHours(w.snipSec)} captured in snips ·
              active on {w.activeDays} days
            </div>
            <div className="muted mt-2 text-xs">
              Listening counts the full length of every episode you snipped — it overcounts anything you didn't finish.
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Stat value={String(w.longestStreak)} label="longest daily streak" hint="Consecutive days with a snip" />
            <Stat value={w.favorites.toLocaleString()} label="⭐ favorites in Snipd" />
            <Stat value={w.quotes.toLocaleString()} label="quotes captured" />
          </div>

          <Card>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">Top shows</h2>
              <div className="flex flex-wrap gap-1">
                {METRICS.map((m) => (
                  <button
                    key={m.key}
                    onClick={() => setMetric(m.key)}
                    title={m.hint}
                    className={`rounded-md px-2 py-1 text-xs ${metric === m.key ? "font-semibold" : "ink-2"}`}
                    style={metric === m.key ? { background: "var(--series-1-soft)" } : {}}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <TopListInline items={ranked} metric={metric} total={w.totalShows} />
            {ranked[0] && metric === "estimatedSec" && (
              <p className="muted mt-3 text-xs">
                {ranked[0].title} alone was {topShare}% of your listening{month ? " this month" : " hours"}.
              </p>
            )}
          </Card>

          <div className="grid gap-4 sm:grid-cols-2">
            <TopList
              title="Most ⭐ favorites"
              items={w.favoriteShows}
              bar={(s) => s.favorites}
              render={(s) => (
                <>
                  {rowLink(`/shows/${s.id}`, s.title)}
                  {rowValue(`${s.favorites.toLocaleString()} ⭐`)}
                </>
              )}
              emptyText="No Snipd favorites in this period."
            />
            <TopList
              title="Busiest days"
              items={w.busiestDays}
              bar={(d) => d.snips}
              render={(d) => (
                <>
                  <span className="min-w-0 flex-1 truncate">{fmtDate(d.date)}</span>
                  {rowValue(`${d.episodes} eps · ${d.snips} snips`)}
                </>
              )}
            />
            {!month && (
              <TopList
                title="Biggest months"
                items={w.biggestMonths}
                bar={(m) => m.episodes}
                render={(m) => (
                  <>
                    <span className="min-w-0 flex-1 truncate">{fmtMonth(m.month)}</span>
                    {rowValue(`${m.episodes} eps · ${m.snips} snips`)}
                  </>
                )}
              />
            )}
            <TopList
              title="Longest episodes"
              items={w.longestEpisodes}
              bar={(e) => e.durationSec ?? 0}
              render={(e) => (
                <>
                  {rowLink(`/episodes/${e.id}`, `${e.title} · ${e.show}`)}
                  {rowValue(fmtClock(e.durationSec))}
                </>
              )}
            />
            <TopList
              title="Most-snipped episodes"
              items={w.mostSnippedEpisodes}
              bar={(e) => e.snips}
              render={(e) => (
                <>
                  {rowLink(`/episodes/${e.id}`, `${e.title} · ${e.show}`)}
                  {rowValue(`${e.snips} snips`)}
                </>
              )}
            />
            <TopList
              title="Densest episodes"
              items={w.densestEpisodes}
              bar={(e) => e.snipsPerHour ?? 0}
              render={(e) => (
                <>
                  {rowLink(`/episodes/${e.id}`, `${e.title} · ${e.show}`)}
                  {rowValue(`${e.snipsPerHour}/hr`)}
                </>
              )}
              note="Episodes under 10 minutes are excluded — short isn't the same as dense."
            />
            <TopList
              title="Snips per hour, by show"
              items={w.densityLeaders}
              bar={(s) => s.snipsPerHour ?? 0}
              render={(s) => (
                <>
                  {rowLink(`/shows/${s.id}`, s.title)}
                  {rowValue(`${s.snipsPerHour}/hr · ${s.snipsPerEpisode}/ep`)}
                </>
              )}
              note="Needs 3+ episodes and 30+ minutes to qualify. Snips/hr favors short episodes, snips/ep favors long ones — both shown."
            />
            <TopList
              title={`New shows you found${month ? " this month" : ` in ${year}`}`}
              items={w.newShows}
              bar={(s) => s.episodes}
              render={(s) => (
                <>
                  {rowLink(`/shows/${s.id}`, s.title)}
                  {rowValue(`${s.episodes} eps`)}
                </>
              )}
            />
            <TopList
              title="Tried once, never returned"
              items={w.oneAndDone}
              render={(s) => rowLink(`/shows/${s.id}`, s.title)}
            />
          </div>

          <Card title="Short-form vs long-form">
            <div className="space-y-2 text-sm">
              {w.durationBuckets.map((b) => (
                <div key={b.label} className="flex items-baseline justify-between gap-3">
                  <span className="w-24 shrink-0 text-xs ink-2">{b.label}</span>
                  <div className="h-2 flex-1 rounded-sm" style={{ background: "var(--grid)" }}>
                    <div
                      className="h-2 rounded-sm"
                      style={{
                        width: `${b.episodes > 0 ? Math.max(2, (b.episodes / maxBucket) * 100) : 0}%`,
                        background: "var(--series-1)",
                      }}
                    />
                  </div>
                  <span className="ink-2 w-44 shrink-0 text-right text-xs" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {b.episodes} eps · {fmtHours(b.estimatedSec)} · {b.snips} snips
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2">
            <Card
              title="Your week"
              action={
                <select
                  className="card px-2 py-1 text-xs"
                  value={weekMetric}
                  onChange={(e) => setWeekMetric(e.target.value as WeekMetric)}
                  aria-label="What to show per weekday"
                >
                  <option value="snips">Snips</option>
                  <option value="episodes">Episodes</option>
                  <option value="estimatedSec">Time listened</option>
                </select>
              }
            >
              <div className="space-y-1.5 text-sm">
                {w.weekdays.map((d) => (
                  <div key={d.day} className="flex items-center gap-2">
                    <span className="w-10 shrink-0 text-xs ink-2">{d.day.slice(0, 3)}</span>
                    <div className="h-2 flex-1 rounded-sm" style={{ background: "var(--grid)" }}>
                      <div
                        className="h-2 rounded-sm"
                        style={{
                          width: `${(d[weekMetric] / maxWeekday) * 100}%`,
                          background: "var(--series-1)",
                        }}
                      />
                    </div>
                    <span className="muted w-12 shrink-0 text-right text-xs">
                      {weekMetric === "estimatedSec" ? fmtHours(d.estimatedSec) : d[weekMetric].toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
            <Card title={month ? `${year} month by month` : "Month by month"}>
              <div className="flex h-32 items-end gap-1">
                {w.months.map((m) => (
                  <div key={m.month} className="flex h-full flex-1 flex-col justify-end gap-1">
                    <div
                      className="w-full rounded-t-sm"
                      style={{
                        height: `${(m.episodes / maxMonth) * 100}%`,
                        minHeight: m.episodes > 0 ? 2 : 0,
                        background: "var(--series-1)",
                        opacity: month && Number(m.month.slice(5)) !== month ? 0.35 : 1,
                      }}
                      title={`${fmtMonth(m.month)}: ${m.episodes} episodes, ${m.snips} snips`}
                    />
                    <span className="muted text-center text-[10px]">{m.month.slice(5)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {w.topTags.length > 0 && (
            <TopList
              title="Top tags"
              items={w.topTags}
              bar={(t) => t.count}
              render={(t) => (
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <TagChip label={t.label} count={t.count} />
                </span>
              )}
            />
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Stat value={w.books.toLocaleString()} label="books mentioned" />
            <Stat value={w.guests.toLocaleString()} label="guests heard" />
          </div>

          <p className="muted text-center text-xs">
            Average episode you snipped: {fmtDuration(Math.round(w.estimatedSec / Math.max(1, w.episodes)))} ·{" "}
            {(w.snips / Math.max(1, w.episodes)).toFixed(1)} snips per episode
          </p>
        </div>
      )}
    </div>
  );
}

/** Top shows keeps its own bar chart, with the same 5/10/25/all control. */
function TopListInline({ items, metric, total }: { items: WrappedShow[]; metric: MetricKey; total: number }) {
  const [size, setSize] = useState(5);
  const shown = items.slice(0, size);
  const max = Math.max(1, ...shown.map((s) => metricValue(s, metric)));
  return (
    <>
      <div className="mb-2 flex justify-end">
        <select value={size} onChange={(e) => setSize(Number(e.target.value))} className="card px-2 py-1 text-xs">
          {[5, 10, 25].map((s) => (
            <option key={s} value={s}>
              Top {s}
            </option>
          ))}
          <option value={total}>All {total}</option>
        </select>
      </div>
      <div className={`space-y-2 ${size > 25 ? "max-h-[32rem] overflow-y-auto pr-1" : ""}`}>
        {shown.map((s, i) => (
          <div key={s.id} className="text-sm">
            <div className="mb-0.5 flex justify-between gap-3">
              <Link to={`/shows/${s.id}`} className="truncate hover:underline">
                <span className="muted mr-1">{i + 1}.</span>
                {s.title}
              </Link>
              <span className="ink-2 shrink-0" style={{ fontVariantNumeric: "tabular-nums" }}>
                {metricText(s, metric)}
              </span>
            </div>
            <div className="h-2 rounded-sm" style={{ background: "var(--grid)" }}>
              <div
                className="h-2 rounded-sm"
                style={{
                  width: `${Math.max(2, (metricValue(s, metric) / max) * 100)}%`,
                  background: "var(--series-1)",
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
