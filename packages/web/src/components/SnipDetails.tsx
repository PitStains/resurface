import { useState } from "react";
import Md from "./Md.tsx";
import { api } from "../api.ts";
import { fmtClock } from "../format.ts";

export interface SnipDetail {
  id: string;
  title: string | null;
  quoteText: string | null;
  quoteAttribution: string | null;
  summaryMd: string | null;
  transcriptMd: string | null;
  startSec: number | null;
  endSec: number | null;
  kind: string;
  shareUrl: string | null;
}

/**
 * Read a snip in place instead of navigating to its episode.
 *
 * Collapsed by default and fetched only on first open: a transcript can run to
 * thousands of characters, and a search page showing 25 results has no reason
 * to download 25 of them. Once opened it stays loaded, so toggling is instant.
 */
function Expanded({
  detail,
  has,
}: {
  detail: SnipDetail;
  has: { summary?: boolean; quote?: boolean };
}) {
  // Does opening this reveal anything besides the transcript? If not, the
  // transcript is the point, so show it rather than asking for a second click.
  const addsNotes = !has.summary && !!detail.summaryMd;
  const addsQuote = !has.quote && !!detail.quoteText;
  const transcriptIsThePoint = !addsNotes && !addsQuote;

  return (
    <>
      <p className="muted mb-2 text-xs">
        {detail.startSec !== null && `${fmtClock(detail.startSec)} – ${fmtClock(detail.endSec)}`}
        {detail.kind === "manual" && " · you made this snip yourself"}
      </p>

      {addsNotes && <Md text={detail.summaryMd!} className="ink-2 mb-3 space-y-0.5 text-sm" />}

      {addsQuote && (
        <blockquote className="mb-3 border-l-2 pl-3 text-sm italic" style={{ borderColor: "var(--series-1)" }}>
          “{detail.quoteText}”
          {detail.quoteAttribution && <span className="ink-2 not-italic"> — {detail.quoteAttribution}</span>}
        </blockquote>
      )}

      {detail.transcriptMd ? (
        <details open={transcriptIsThePoint}>
          <summary className="link cursor-pointer text-xs">Transcript</summary>
          <Md text={detail.transcriptMd} className="ink-2 mt-2 space-y-1 text-sm" />
        </details>
      ) : (
        <p className="muted text-xs">No transcript was exported for this snip.</p>
      )}
    </>
  );
}

export default function SnipDetails({
  snipId,
  /** What the row already shows, so the expansion doesn't repeat it. */
  has = {},
  label = "Read the full snip",
}: {
  snipId: string;
  has?: { summary?: boolean; quote?: boolean };
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<SnipDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || detail || loading) return;
    setLoading(true);
    setError(false);
    try {
      setDetail(await api<SnipDetail>(`/api/snips/${snipId}/full`));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2">
      <button
        onClick={() => void toggle()}
        aria-expanded={open}
        className="link text-xs"
        title="Show this snip's notes and transcript without leaving the page"
      >
        {open ? "▾ Hide" : "▸"} {open ? "" : label}
      </button>

      {open && (
        <div className="mt-2 border-l-2 pl-3" style={{ borderColor: "var(--grid)" }}>
          {loading && <p className="muted text-xs">Loading…</p>}
          {error && <p className="muted text-xs">Couldn't load this snip.</p>}
          {detail && <Expanded detail={detail} has={has} />}
        </div>
      )}
    </div>
  );
}
