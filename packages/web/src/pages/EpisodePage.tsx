import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type EpisodeDetail } from "../api.ts";
import CopyButton from "../components/CopyButton.tsx";
import Md from "../components/Md.tsx";
import RelatedSnips from "../components/RelatedSnips.tsx";
import TagChip from "../components/TagChip.tsx";
import { Bookmark, FavBadge, MissingBadge } from "../favorites.tsx";
import { fmtClock, fmtDate } from "../format.ts";

export default function EpisodePage() {
  const { id } = useParams();
  const [ep, setEp] = useState<EpisodeDetail | null>(null);

  useEffect(() => {
    if (id) api<EpisodeDetail>(`/api/episodes/${id}`).then(setEp);
  }, [id]);

  if (!ep) return <p className="muted">Loading…</p>;
  return (
    <div>
      <Link to={`/shows/${ep.showId}`} className="muted text-sm">
        ← {ep.showTitle}
      </Link>
      <div className="mb-1 mt-2 flex items-start gap-4">
        {ep.imageUrl && <img src={ep.imageUrl} alt="" loading="lazy" className="h-16 w-16 rounded-xl" />}
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Bookmark type="episode" id={ep.id} size="text-xl" /> {ep.title}
          </h1>
          <div className="ink-2 mt-1 text-sm">
            {fmtDate(ep.publishDate)} · {fmtClock(ep.durationSec)} · {ep.snips.length} snips
            {ep.url && (
              <>
                {" · "}
                <a href={ep.url} target="_blank" rel="noreferrer" className="link">
                  Open in Snipd ↗
                </a>
              </>
            )}
          </div>
          {(ep.guests.length > 0 || ep.books.length > 0) && (
            <div className="muted mt-1 text-xs">
              {ep.guests.length > 0 && <>Guests: {ep.guests.map((g) => g.name).join(", ")}</>}
              {ep.guests.length > 0 && ep.books.length > 0 && " · "}
              {ep.books.length > 0 && <>Books: {ep.books.map((b) => b.title).join(", ")}</>}
            </div>
          )}
        </div>
      </div>
      {ep.aiDescription && <p className="ink-2 mb-5 mt-3 max-w-3xl text-sm">{ep.aiDescription}</p>}

      <div className="space-y-4">
        {ep.snips.map((s) => (
          <div key={s.id} className="card p-4">
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              {s.favorited ? <FavBadge /> : null}
              <Bookmark type="snip" id={s.id} />
              <h2 className="text-sm font-semibold">{s.title}</h2>
              {s.tagsJson &&
                (JSON.parse(s.tagsJson) as string[]).map((t) => <TagChip key={t} label={t} />)}
              {s.missingFromVault ? <MissingBadge /> : null}
              <span
                className="rounded px-1.5 py-0.5 text-xs"
                style={{ background: "var(--series-1-soft)", fontVariantNumeric: "tabular-nums" }}
              >
                {fmtClock(s.startSec)} – {fmtClock(s.endSec)}
              </span>
              <span className="ml-auto flex items-center gap-3">
                <CopyButton
                  snip={{
                    ...s,
                    episodeTitle: ep.title,
                    showTitle: ep.showTitle,
                    lastSnipDate: ep.lastSnipDate,
                  }}
                />
                {s.shareUrl && (
                  <a href={s.shareUrl} target="_blank" rel="noreferrer" className="link text-xs">
                    Play in Snipd ↗
                  </a>
                )}
              </span>
            </div>
            {s.summaryMd && <Md text={s.summaryMd} className="ink-2 mb-3 space-y-1 text-sm" />}
            {s.quoteText && (
              <blockquote
                className="mb-3 border-l-2 py-0.5 pl-3 text-sm italic"
                style={{ borderColor: "var(--series-1)" }}
              >
                “{s.quoteText}”
                {s.quoteAttribution && <span className="ink-2 not-italic"> — {s.quoteAttribution}</span>}
              </blockquote>
            )}
            {s.transcriptMd && (
              <details>
                <summary className="muted cursor-pointer text-xs">Transcript</summary>
                <Md text={s.transcriptMd} className="ink-2 mt-2 max-w-3xl text-sm" />
              </details>
            )}
            <RelatedSnips snipId={s.id} />
          </div>
        ))}
      </div>
    </div>
  );
}
