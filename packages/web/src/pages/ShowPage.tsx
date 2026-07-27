import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type ShowDetail } from "../api.ts";
import { Bookmark } from "../favorites.tsx";
import { fmtClock, fmtDate } from "../format.ts";

export default function ShowPage() {
  const { id } = useParams();
  const [show, setShow] = useState<ShowDetail | null>(null);

  useEffect(() => {
    if (id) api<ShowDetail>(`/api/shows/${id}`).then(setShow);
  }, [id]);

  if (!show) return <p className="muted">Loading…</p>;
  return (
    <div>
      <Link to="/library" className="muted text-sm">
        ← Library
      </Link>
      <div className="mb-5 mt-2 flex items-center gap-4">
        {show.imageUrl && <img src={show.imageUrl} alt="" className="h-16 w-16 rounded-xl" />}
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Bookmark type="show" id={show.id} size="text-xl" /> {show.title}
          </h1>
          <div className="ink-2 text-sm">
            {show.author} · {show.episodes.length} snipped episodes
            {show.url && (
              <>
                {" · "}
                <a href={show.url} target="_blank" rel="noreferrer" className="link">
                  Open in Snipd ↗
                </a>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="space-y-2">
        {show.episodes.map((e) => (
          <Link key={e.id} to={`/episodes/${e.id}`} className="card block p-3 hover:opacity-90">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-sm font-medium">{e.title}</span>
              <span className="muted shrink-0 text-xs">
                {e.snips} snips · {fmtClock(e.durationSec)} · {fmtDate(e.lastSnipDate)}
              </span>
            </div>
            {e.aiDescription && <p className="ink-2 mt-1 line-clamp-2 text-xs">{e.aiDescription}</p>}
          </Link>
        ))}
      </div>
    </div>
  );
}
