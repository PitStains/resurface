import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.ts";
import { fmtClock, fmtDate } from "../format.ts";
import SnipDetails from "../components/SnipDetails.tsx";

interface DatedSnip {
  id: string;
  title: string | null;
  quoteText: string | null;
  startSec: number | null;
  shareUrl: string | null;
  favorited: number;
  kind: string;
  showId: string;
  showTitle: string;
  episodeId: string;
  episodeTitle: string;
  lastSnipDate: string | null;
}
interface Digest {
  from: string;
  to: string;
  episodes: number;
  snips: number;
  shows: number;
  favorites: number;
  topShows: { id: string; title: string; snips: number }[];
  emergingTopics: { label: string; snips: number; previous: number; change: number }[];
  gems: DatedSnip[];
  narrative: string;
}
interface OnThisDay {
  groups: { date: string; monthsAgo: number; label: string; snips: DatedSnip[] }[];
  historyStart: string | null;
}

function SnipRow({ s }: { s: DatedSnip }) {
  return (
    <div className="card p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <Link to={`/shows/${s.showId}`} className="font-medium hover:underline">
          {s.showTitle}
        </Link>
        <span className="muted">›</span>
        <Link to={`/episodes/${s.episodeId}`} className="min-w-0 truncate hover:underline">
          {s.episodeTitle}
        </Link>
        <span className="muted text-xs">
          {fmtClock(s.startSec)} · {fmtDate(s.lastSnipDate)}
        </span>
        {s.favorited === 1 && <span title="Favorited in Snipd">⭐</span>}
        {s.shareUrl && (
          <a href={s.shareUrl} target="_blank" rel="noreferrer" className="link ml-auto text-xs">
            Play ↗
          </a>
        )}
      </div>
      {s.title && <p className="mt-1 font-medium">{s.title}</p>}
      {s.quoteText && <p className="ink-2 mt-1">{s.quoteText}</p>}
      <SnipDetails snipId={s.id} has={{ quote: !!s.quoteText }} />
    </div>
  );
}

/**
 * The weekly digest, "on this day", and one-click serendipity — the parts of
 * resurfacing that aren't the scheduled daily review.
 */
export default function DigestPage() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [otd, setOtd] = useState<OnThisDay | null>(null);
  const [lucky, setLucky] = useState<DatedSnip | null>(null);

  useEffect(() => {
    api<Digest>("/api/digest").then(setDigest).catch(() => {});
    api<OnThisDay>("/api/on-this-day").then(setOtd).catch(() => {});
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="mb-1 text-lg font-semibold">This week</h1>
        {digest && (
          <p className="muted text-xs">
            {fmtDate(digest.from)} – {fmtDate(digest.to)} ·{" "}
            <a href="/api/digest.xml" className="link">
              subscribe by feed
            </a>
          </p>
        )}
      </div>

      {digest && (
        <div className="card p-5">
          <p className="text-sm">{digest.narrative}</p>
          <div className="mt-3 flex flex-wrap gap-4 text-xs">
            <span>
              <span className="font-semibold">{digest.snips.toLocaleString()}</span> snips
            </span>
            <span>
              <span className="font-semibold">{digest.episodes.toLocaleString()}</span> episodes
            </span>
            <span>
              <span className="font-semibold">{digest.shows}</span> shows
            </span>
            <span>
              <span className="font-semibold">{digest.favorites}</span> ⭐
            </span>
          </div>
          {digest.emergingTopics.length > 0 && (
            <div className="mt-4">
              <h2 className="mb-1 text-xs font-semibold">Themes this week</h2>
              <ul className="space-y-0.5 text-xs">
                {digest.emergingTopics.map((t) => (
                  <li key={t.label} className="flex justify-between gap-3">
                    <span className="truncate">{t.label}</span>
                    <span className="muted shrink-0" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {t.snips} {t.change > 0 ? `(▲ ${t.change})` : t.change < 0 ? `(▼ ${-t.change})` : "(—)"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {digest && digest.gems.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold">You'd forgotten these</h2>
          <p className="muted mb-2 text-xs">Older snips that have never been resurfaced.</p>
          <div className="space-y-2">
            {digest.gems.map((g) => (
              <SnipRow key={g.id} s={g} />
            ))}
          </div>
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold">Something at random</h2>
        <button
          className="card px-3 py-1.5 text-xs hover:opacity-80"
          onClick={() => void api<DatedSnip | null>("/api/serendipity").then(setLucky)}
        >
          {lucky ? "Show me another" : "Surprise me"}
        </button>
        {lucky && (
          <div className="mt-2">
            <SnipRow s={lucky} />
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold">On this day</h2>
        {otd && otd.groups.length === 0 && (
          <p className="muted text-xs">
            Nothing from this date in an earlier month
            {otd.historyStart && ` — your library starts on ${fmtDate(otd.historyStart)}`}.
          </p>
        )}
        {otd?.groups.map((g) => (
          <div key={g.date} className="mb-4">
            <h3 className="mb-1 text-xs font-semibold">
              {g.label} <span className="muted font-normal">· {fmtDate(g.date)}</span>
            </h3>
            <div className="space-y-2">
              {g.snips.map((s) => (
                <SnipRow key={s.id} s={s} />
              ))}
            </div>
          </div>
        ))}
        <p className="muted mt-2 text-xs">
          Snipd's export carries no per-snip timestamp, so these are dated by the day their episode was last
          snipped.
        </p>
      </div>
    </div>
  );
}
