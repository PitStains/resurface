import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  postJson,
  request,
  LONG_TIMEOUT_MS,
  type AskAnswer,
  type CategoriesStatus,
  type EmbedStatus,
} from "../api.ts";
import { fmtClock, fmtDate } from "../format.ts";
import LocalModelPanel from "../components/LocalModelPanel.tsx";
import NotebookLmPanel from "../components/NotebookLmPanel.tsx";
import SnipDetails from "../components/SnipDetails.tsx";

/** Deliberately subject-neutral: whatever someone listens to, these still fit. */
const EXAMPLES = [
  "What have I heard about staying steady under pressure?",
  "How should I think about money and generosity?",
  "What do my podcasts say about building a habit that lasts?",
];

/**
 * Ask answers only from your own snips, and every claim carries a citation.
 * With no model configured it quotes the passages directly — nothing is
 * generated, so nothing can be invented. A local Ollama model, if you have one,
 * writes a short summary over those same passages.
 */
export default function AskPage() {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [embed, setEmbed] = useState<EmbedStatus | null>(null);
  const [status, setStatus] = useState<CategoriesStatus | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<EmbedStatus>("/api/embeddings/status").then(setEmbed).catch(() => {});
    api<CategoriesStatus>("/api/categories/status").then(setStatus).catch(() => {});
    inputRef.current?.focus();
  }, []);

  async function run(question: string) {
    if (!question.trim()) return;
    setLoading(true);
    setError(null);
    try {
      // A local model can take minutes on a slow machine; that is not a stall.
      const res = await request("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        timeoutMs: LONG_TIMEOUT_MS,
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Ask failed");
        setAnswer(null);
      } else setAnswer(body as AskAnswer);
    } catch {
      setError("Ask failed");
    } finally {
      setLoading(false);
    }
  }

  const ready = (embed?.embedded ?? 0) > 0;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-lg font-semibold">Ask</h1>
      <p className="muted mb-4 text-xs">
        Answers come only from snips you've saved, with a citation on every line.
        {status?.llm
          ? ` Using your local ${status.llm.model ?? "Ollama"} model to summarize.`
          : " No model configured, so passages are quoted verbatim — nothing is generated."}
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(q);
        }}
        className="mb-3 flex gap-2"
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask anything about what you've listened to…"
          className="card w-full px-4 py-2 text-sm outline-none"
        />
        <button className="card px-3 py-2 text-sm hover:opacity-80 disabled:opacity-50" disabled={loading || !ready}>
          {loading ? "Thinking…" : "Ask"}
        </button>
      </form>

      {!ready && (
        <p className="mb-4 text-sm" style={{ color: "var(--series-1)" }}>
          Ask needs the meaning index — build it on the dashboard first.
        </p>
      )}

      {!answer && ready && (
        <div className="muted space-y-1 text-sm">
          <p>Try:</p>
          {EXAMPLES.map((e) => (
            <button
              key={e}
              className="link block text-left"
              onClick={() => {
                setQ(e);
                void run(e);
              }}
            >
              {e}
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-sm" style={{ color: "var(--series-1)" }}>{error}</p>}

      {answer && (
        <div className="space-y-4">
          <div className="card p-5">
            <div className="whitespace-pre-wrap text-sm">{answer.answer}</div>
            <p className="muted mt-3 text-xs">
              {answer.mode === "llm" ? "Summarized by your local model" : "Quoted directly from your snips"} ·{" "}
              {answer.sources.length} sources · {answer.tookMs} ms
            </p>
            {answer.llmError && (
              <p className="muted mt-1 text-xs">
                Your local model didn't answer ({answer.llmError}), so these are the passages themselves — a complete
                answer, just not a written one. Check the local model panel below.
              </p>
            )}
          </div>

          <h2 className="text-sm font-semibold">Sources</h2>
          <div className="space-y-2">
            {answer.sources.map((s) => (
              <div key={s.id} className="card p-3 text-sm">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="shrink-0 font-semibold">[{s.n}]</span>
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
                  {s.favorited && <span title="Favorited in Snipd">⭐</span>}
                  {s.shareUrl && (
                    <a href={s.shareUrl} target="_blank" rel="noreferrer" className="link ml-auto text-xs">
                      Play ↗
                    </a>
                  )}
                </div>
                <p className="ink-2 mt-1 text-sm">{s.passage}</p>
                <SnipDetails snipId={s.id} label="Read the full snip" />
              </div>
            ))}
          </div>

        </div>
      )}

      {/* Always reachable: a broken connection has to be fixable from here. */}
      <div className="mt-4 space-y-3">
        <LocalModelPanel />
        {/* The other way to put a model on this library: hand it to one that
            can hold the whole thing at once, which means an export. */}
        <NotebookLmPanel />
      </div>
    </div>
  );
}
