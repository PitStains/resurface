import { Link } from "react-router-dom";
import CopyButton from "./CopyButton.tsx";
import Md from "./Md.tsx";
import RelatedSnips from "./RelatedSnips.tsx";
import SnipDetails from "./SnipDetails.tsx";
import TagChip from "./TagChip.tsx";
import { Bookmark, FavBadge, MissingBadge } from "../favorites.tsx";
import { fmtClock, fmtDate } from "../format.ts";

/** FTS snippet text with <mark> highlights, rendered safely (no innerHTML). */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/<mark>|<\/mark>/g);
  return (
    <p className="ink-2 text-sm">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} style={{ background: "var(--series-1-soft)", color: "inherit", borderRadius: 2 }}>
            {p}
          </mark>
        ) : (
          p
        )
      )}
    </p>
  );
}

export interface SnipCardData {
  id: string;
  title: string | null;
  quoteText: string | null;
  quoteAttribution: string | null;
  summaryMd: string | null;
  transcriptSnippet?: string | null;
  startSec: number | null;
  endSec: number | null;
  shareUrl: string | null;
  episodeId: string;
  episodeTitle: string;
  lastSnipDate: string | null;
  showId: string;
  showTitle: string;
  favorited: boolean;
  missingFromVault: boolean;
  tags: string[];
  bookmarkEpisode?: boolean;
  bookmarkShow?: boolean;
  bookmarkSnip?: boolean;
}

/**
 * One snip, led by its podcast: the show and episode are the primary line so a
 * list of snips always says where each came from, with the snip's own title,
 * timestamp and tags beneath.
 */
export default function SnipCard({
  snip: h,
  onTagClick,
  activeTags = [],
  showRelated = false,
}: {
  snip: SnipCardData;
  onTagClick?: (key: string) => void;
  activeTags?: string[];
  showRelated?: boolean;
}) {
  return (
    <div className="card p-4">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        {h.favorited && <FavBadge />}
        <Bookmark type="snip" id={h.id} />
        <Link to={`/shows/${h.showId}`} className="font-semibold hover:underline">
          {h.showTitle}
        </Link>
        <span className="muted">›</span>
        <Link to={`/episodes/${h.episodeId}`} className="min-w-0 truncate font-medium hover:underline">
          {h.episodeTitle}
        </Link>
        <span className="muted text-xs">{fmtDate(h.lastSnipDate)}</span>
        <span className="ml-auto flex items-center gap-3">
          <CopyButton snip={h} />
          {h.shareUrl && (
            <a href={h.shareUrl} target="_blank" rel="noreferrer" className="link text-xs">
              Play ↗
            </a>
          )}
        </span>
      </div>

      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <span className="ink-2 text-sm">{h.title ?? "(untitled snip)"}</span>
        <span
          className="muted rounded px-1.5 py-0.5 text-xs"
          style={{ background: "var(--series-1-soft)", fontVariantNumeric: "tabular-nums" }}
        >
          {fmtClock(h.startSec)} – {fmtClock(h.endSec)}
        </span>
        {h.tags.map((t) =>
          onTagClick ? (
            <TagChip
              key={t}
              label={t}
              active={activeTags.includes(t.toLowerCase())}
              onClick={() => onTagClick(t.toLowerCase())}
            />
          ) : (
            <TagChip key={t} label={t} />
          )
        )}
        {h.missingFromVault && <MissingBadge />}
        {(h.bookmarkEpisode || h.bookmarkShow) && !h.bookmarkSnip && !h.favorited && (
          <span className="muted text-xs" title="Ranked higher: bookmarked episode or show">
            🔖 boosted
          </span>
        )}
      </div>

      {h.summaryMd && <Md text={h.summaryMd} className="ink-2 mb-2 space-y-0.5 text-sm" />}
      {h.quoteText && (
        <blockquote className="mb-2 border-l-2 pl-3 text-sm italic" style={{ borderColor: "var(--series-1)" }}>
          “{h.quoteText}”{h.quoteAttribution && <span className="ink-2 not-italic"> — {h.quoteAttribution}</span>}
        </blockquote>
      )}
      {h.transcriptSnippet && <Snippet text={h.transcriptSnippet} />}
      <SnipDetails
        snipId={h.id}
        has={{ summary: !!h.summaryMd, quote: !!h.quoteText }}
        label={h.transcriptSnippet ? "Read the full transcript" : "Read the full snip"}
      />
      {showRelated && <RelatedSnips snipId={h.id} />}
    </div>
  );
}
