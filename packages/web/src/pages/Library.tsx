import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ShowListItem } from "../api.ts";
import { fmtDate } from "../format.ts";

export default function Library() {
  const [shows, setShows] = useState<ShowListItem[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    api<ShowListItem[]>("/api/shows").then(setShows);
  }, []);

  const filtered = useMemo(
    () => shows.filter((s) => s.title.toLowerCase().includes(q.toLowerCase())),
    [shows, q]
  );

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-lg font-semibold">Library</h1>
        <span className="muted text-sm">{shows.length} shows</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter shows…"
          className="card ml-auto w-64 px-3 py-1.5 text-sm outline-none"
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((s) => (
          <Link key={s.id} to={`/shows/${s.id}`} className="card flex items-center gap-3 p-3 hover:opacity-90">
            {s.imageUrl ? (
              <img src={s.imageUrl} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-lg" />
            ) : (
              <div className="h-12 w-12 shrink-0 rounded-lg" style={{ background: "var(--series-1-soft)" }} />
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{s.title}</div>
              <div className="muted truncate text-xs">
                {s.episodes} episodes · {s.snips} snips · {fmtDate(s.lastActivity)}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
