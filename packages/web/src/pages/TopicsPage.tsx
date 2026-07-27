import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, postJson, type SearchHit, type Topic, type TopicsStatus } from "../api.ts";
import SnipCard from "../components/SnipCard.tsx";
import { fmtDate } from "../format.ts";

/**
 * Topics are discovered, not declared: k-means over the snip vectors, named
 * after the words that set each group apart. They're a lens on what you
 * actually listen to, so a rebuild after a lot of new snips is expected.
 */
export default function TopicsPage() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [status, setStatus] = useState<TopicsStatus | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setStatus(await api<TopicsStatus>("/api/topics/status").catch(() => null));
    setTopics(await api<Topic[]>("/api/topics").catch(() => []));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!status?.job.running) return;
    const t = window.setInterval(load, 2000);
    return () => window.clearInterval(t);
  }, [status?.job.running, load]);

  async function build() {
    setBusy(true);
    try {
      await postJson("/api/topics/build", {});
      await load();
    } finally {
      setBusy(false);
    }
  }

  const max = Math.max(1, ...topics.map((t) => t.size));
  const noVectors = (status?.vectors ?? 0) === 0;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Topics</h1>
        <Link to="/map" className="link text-sm">
          See the map →
        </Link>
        <div className="ml-auto text-xs">
          {status?.job.running ? (
            <span className="ink-2">
              Building… {status.job.phase} {status.job.total > 1 && `${status.job.done}/${status.job.total}`}
            </span>
          ) : (
            <button
              className="card px-2 py-1 hover:opacity-80 disabled:opacity-50"
              onClick={build}
              disabled={busy || noVectors}
              title={noVectors ? "Build the meaning index on the dashboard first" : undefined}
            >
              {topics.length > 0 ? "Rebuild topics" : "Find topics"}
            </button>
          )}
        </div>
      </div>
      <p className="muted mb-4 text-xs">
        Groups found in your own snips by meaning — not a fixed list. Names come from the words that distinguish each
        group, so they read as hints rather than titles. Rebuild after a big batch of new snips.
      </p>

      {topics.length === 0 && (
        <div className="card p-8 text-center">
          <p className="mb-1 text-sm font-medium">No topics yet</p>
          <p className="muted text-sm">
            {noVectors
              ? "Build the meaning index on the dashboard, then come back and find topics."
              : "Click “Find topics” — it takes about a minute."}
          </p>
        </div>
      )}

      <div className="space-y-2">
        {topics.map((t) => (
          <div key={t.id} className="card p-3">
            <button className="flex w-full items-center gap-3 text-left" onClick={() => setOpen(open === t.id ? null : t.id)}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{t.label}</div>
                <div className="mt-1 h-1.5 rounded-sm" style={{ background: "var(--grid)" }}>
                  <div
                    className="h-1.5 rounded-sm"
                    style={{ width: `${Math.max(2, (t.size / max) * 100)}%`, background: "var(--series-1)" }}
                  />
                </div>
              </div>
              <div className="shrink-0 text-right text-xs" style={{ fontVariantNumeric: "tabular-nums" }}>
                <div className="text-sm font-medium">{t.size.toLocaleString()} snips</div>
                <div className="muted">
                  {t.shows} shows{t.favorites > 0 && ` · ${t.favorites} ⭐`}
                  {t.lastDate && ` · ${fmtDate(t.lastDate)}`}
                </div>
              </div>
            </button>
            {open === t.id && <TopicSnips id={t.id} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function TopicSnips({ id }: { id: number }) {
  const [snips, setSnips] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(5);
  useEffect(() => {
    api<{ snips: SearchHit[]; total: number }>(`/api/topics/${id}/snips?limit=${limit}`)
      .then((r) => {
        setSnips(r.snips);
        setTotal(r.total);
      })
      .catch(() => setSnips([]));
  }, [id, limit]);
  return (
    <div className="mt-3 space-y-3 border-t pt-3 hairline">
      {snips.map((s) => (
        <SnipCard key={s.id} snip={s} />
      ))}
      {snips.length < total && (
        <button className="link text-sm" onClick={() => setLimit(limit + 10)}>
          Show more ({total - snips.length} remaining)
        </button>
      )}
    </div>
  );
}
