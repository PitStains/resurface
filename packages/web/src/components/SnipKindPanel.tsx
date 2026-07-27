import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, postJson } from "../api.ts";
import { fmtClock } from "../format.ts";

interface KindStats {
  auto: number;
  manual: number;
  unsure: number;
  overridden: number;
}
interface UnsureSnip {
  id: string;
  title: string | null;
  kind: "auto" | "manual";
  kindReason: string;
  startSec: number | null;
  endSec: number | null;
  episodeTitle: string;
  episodeId: string;
  showTitle: string;
  noteChars: number;
}

/**
 * Who made each snip, and settling the ones the classifier is unsure about.
 *
 * The guess is made from the shape of a note, which is right the overwhelming
 * majority of the time and openly uncertain for a small remainder. Rather than
 * hide that, the doubtful ones are listed here to be settled by the only person
 * who actually knows. A decision made here is permanent — re-importing never
 * overrides it.
 */
export default function SnipKindPanel() {
  const [stats, setStats] = useState<KindStats | null>(null);
  const [queue, setQueue] = useState<UnsureSnip[] | null>(null);
  const [open, setOpen] = useState(false);
  const [decided, setDecided] = useState<Record<string, "auto" | "manual">>({});

  const refresh = () => api<KindStats>("/api/snips/kinds").then(setStats).catch(() => {});
  useEffect(() => {
    void refresh();
  }, []);

  async function loadQueue() {
    setOpen(true);
    if (queue) return;
    setQueue(await api<UnsureSnip[]>("/api/snips/kinds/unsure?limit=50").catch(() => []));
  }

  async function decide(id: string, kind: "auto" | "manual") {
    setDecided((d) => ({ ...d, [id]: kind }));
    await postJson(`/api/snips/${id}/kind`, { kind });
    void refresh();
  }

  if (!stats) return null;
  const total = stats.auto + stats.manual;
  const manualPct = total > 0 ? Math.round((stats.manual / total) * 100) : 0;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Who made your snips</h2>
        <Link to="/search?kind=manual" className="link text-xs">
          Browse the ones you made →
        </Link>
      </div>

      <p className="muted mt-2 text-xs">
        Snipd writes most snips from a fixed template; the ones you made by hand look different. Resurface
        tells them apart by the shape of the note, never its length of audio. This is a filter only — it never
        changes search ranking.
      </p>

      <div className="mt-3 flex flex-wrap gap-4 text-xs">
        <span>
          <span className="font-semibold">{stats.manual.toLocaleString()}</span> made by you ({manualPct}%)
        </span>
        <span>
          <span className="font-semibold">{stats.auto.toLocaleString()}</span> auto-generated
        </span>
        {stats.overridden > 0 && (
          <span className="muted">{stats.overridden.toLocaleString()} you corrected</span>
        )}
      </div>

      {stats.unsure > 0 && !open && (
        <button className="link mt-3 text-xs" onClick={() => void loadQueue()}>
          {stats.unsure.toLocaleString()} are borderline — settle them →
        </button>
      )}
      {stats.unsure === 0 && <p className="muted mt-3 text-xs">Nothing borderline left to settle.</p>}

      {open && (
        <div className="mt-3">
          <p className="muted mb-2 text-xs">
            These sit near the boundary. Your answer is permanent — a future import won't undo it.
          </p>
          {queue === null && <p className="muted text-xs">Loading…</p>}
          {queue?.length === 0 && <p className="muted text-xs">Nothing left to settle.</p>}
          <ul className="space-y-2">
            {queue?.map((s) => (
              <li key={s.id} className="border-t pt-2 text-xs hairline">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Link to={`/episodes/${s.episodeId}`} className="font-medium hover:underline">
                    {s.showTitle}
                  </Link>
                  <span className="muted">›</span>
                  <span className="muted min-w-0 truncate">{s.episodeTitle}</span>
                  {s.startSec !== null && <span className="muted">{fmtClock(s.startSec)}</span>}
                </div>
                <p className="mt-0.5">{s.title ?? "(untitled snip)"}</p>
                <p className="muted mt-0.5">
                  Guessed <span className="font-medium">{s.kind === "manual" ? "made by you" : "auto"}</span> —{" "}
                  {s.kindReason} · {s.noteChars.toLocaleString()} characters of notes
                </p>
                {decided[s.id] ? (
                  <p className="mt-1">Saved as {decided[s.id] === "manual" ? "made by you" : "auto-generated"}.</p>
                ) : (
                  <div className="mt-1 flex gap-2">
                    <button className="card px-2 py-1" onClick={() => void decide(s.id, "manual")}>
                      I made this
                    </button>
                    <button className="card px-2 py-1" onClick={() => void decide(s.id, "auto")}>
                      Snipd made it
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
