import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, postJson } from "../api.ts";
import { fmtClock, fmtDate } from "../format.ts";
import SnipDetails from "../components/SnipDetails.tsx";

interface ReviewCard {
  id: string;
  title: string | null;
  quoteText: string | null;
  summaryMd: string | null;
  startSec: number | null;
  shareUrl: string | null;
  favorited: number;
  kind: string;
  showId: string;
  showTitle: string;
  episodeId: string;
  episodeTitle: string;
  lastSnipDate: string | null;
  topicLabel: string | null;
  timesShown: number;
  reason: string;
}
interface ReviewStats {
  reviewed: number;
  seenSnips: number;
  muted: number;
  dueToday: number;
  neverSeen: number;
  eligible: number;
}
type Action = "keep" | "more" | "less" | "mute";

const ACTIONS: { action: Action; label: string; hint: string }[] = [
  { action: "keep", label: "Keep", hint: "Worth remembering — show it again later, less often each time" },
  { action: "more", label: "More like this", hint: "Bring it back sooner" },
  { action: "less", label: "Less like this", hint: "Push it far out, but don't lose it" },
  { action: "mute", label: "Stop showing", hint: "Never in review again. Stays in your library and search." },
];

/**
 * The daily review: a handful of snips a day out of ~32k, chosen by weighted
 * sampling and then scheduled by spaced repetition. Every card says why it was
 * picked, and nothing here removes anything from the library.
 */
export default function ReviewPage() {
  const [cards, setCards] = useState<ReviewCard[] | null>(null);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [done, setDone] = useState<Record<string, Action>>({});

  const load = () =>
    api<{ cards: ReviewCard[]; stats: ReviewStats }>("/api/review").then((r) => {
      setCards(r.cards);
      setStats(r.stats);
    });

  useEffect(() => {
    void load();
  }, []);

  async function act(id: string, action: Action) {
    setDone((d) => ({ ...d, [id]: action }));
    await postJson(`/api/review/${id}`, { action });
  }

  if (!cards) return <p className="muted mx-auto max-w-3xl text-sm">Loading…</p>;

  const remaining = cards.filter((c) => !done[c.id]);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-lg font-semibold">Daily review</h1>
      <p className="muted mb-4 text-xs">
        {stats && (
          <>
            {stats.neverSeen.toLocaleString()} of {stats.eligible.toLocaleString()} snips have never come back
            to you{stats.dueToday > 0 && ` · ${stats.dueToday} due today`}
            {stats.muted > 0 && ` · ${stats.muted} muted`}
          </>
        )}
      </p>

      {remaining.length === 0 && (
        <div className="card p-5">
          <p className="text-sm font-medium">That's today's review.</p>
          <p className="muted mt-1 text-xs">
            Come back tomorrow for a new set. Anything you kept will return on a widening schedule — 3 days,
            then a week, then three weeks, and so on.
          </p>
        </div>
      )}

      <div className="space-y-4">
        {cards.map((c) => {
          const choice = done[c.id];
          return (
            <div key={c.id} className="card p-5" style={choice ? { opacity: 0.55 } : undefined}>
              <div className="mb-2 flex flex-wrap items-baseline gap-2 text-sm">
                <Link to={`/shows/${c.showId}`} className="font-medium hover:underline">
                  {c.showTitle}
                </Link>
                <span className="muted">›</span>
                <Link to={`/episodes/${c.episodeId}`} className="min-w-0 truncate hover:underline">
                  {c.episodeTitle}
                </Link>
                <span className="muted text-xs">
                  {fmtClock(c.startSec)} · {fmtDate(c.lastSnipDate)}
                </span>
                {c.favorited === 1 && <span title="Favorited in Snipd">⭐</span>}
                {c.kind === "manual" && (
                  <span className="muted text-xs" title="You made this snip yourself">
                    hand-made
                  </span>
                )}
              </div>

              {c.title && <h2 className="text-sm font-semibold">{c.title}</h2>}
              {c.quoteText && (
                <blockquote className="ink-2 mt-2 border-l-2 pl-3 text-sm" style={{ borderColor: "var(--grid)" }}>
                  {c.quoteText}
                </blockquote>
              )}

              <SnipDetails snipId={c.id} has={{ quote: !!c.quoteText }} />

              <p className="muted mt-3 text-xs">
                Why this: {c.reason}
                {c.topicLabel && ` · ${c.topicLabel}`}
              </p>

              {choice ? (
                <p className="mt-3 text-xs">
                  {choice === "mute" ? "Won't appear in review again." : "Saved — it'll come back later."}
                </p>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  {ACTIONS.map((a) => (
                    <button
                      key={a.action}
                      title={a.hint}
                      onClick={() => void act(c.id, a.action)}
                      className="card px-2 py-1 text-xs hover:opacity-80"
                    >
                      {a.label}
                    </button>
                  ))}
                  {c.shareUrl && (
                    <a href={c.shareUrl} target="_blank" rel="noreferrer" className="link ml-auto text-xs">
                      Play in Snipd ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
