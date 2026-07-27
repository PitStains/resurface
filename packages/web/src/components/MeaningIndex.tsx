import { useCallback, useEffect, useRef, useState } from "react";
import { api, postJson, type EmbedSpeed, type EmbedStatus } from "../api.ts";

/**
 * Build state for the local meaning index (Phase 3). Everything runs on this
 * machine — the model is downloaded once and no snip text ever leaves the box.
 */
const SPEEDS: { key: EmbedSpeed; label: string; hint: string }[] = [
  { key: "gentle", label: "Gentle", hint: "One core with pauses — keep working while it builds" },
  { key: "balanced", label: "Balanced", hint: "Two cores; noticeably faster, machine still usable" },
  { key: "fast", label: "Fast", hint: "All cores — quickest, but expect a busy machine" },
];

export default function MeaningIndex() {
  const [status, setStatus] = useState<EmbedStatus | null>(null);
  const [speed, setSpeed] = useState<EmbedSpeed>("gentle");
  const [busy, setBusy] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    const s = await api<EmbedStatus>("/api/embeddings/status").catch(() => null);
    setStatus(s);
    if (s?.job.speed) setSpeed(s.job.speed);
    return s;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while a build is running.
  useEffect(() => {
    if (!status?.job.running) {
      if (timer.current) window.clearInterval(timer.current);
      timer.current = null;
      return;
    }
    timer.current = window.setInterval(load, 2000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [status?.job.running, load]);

  if (!status) return null;

  const { embedded, total, pending, job } = status;
  const pct = total > 0 ? Math.round((embedded / total) * 100) : 0;
  const complete = pending === 0 && embedded > 0;

  async function build() {
    setBusy(true);
    try {
      await postJson(`/api/embeddings/build?speed=${speed}`, {});
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4">
      <h2 className="mb-1 text-sm font-semibold">
        Meaning index{" "}
        <span className="muted font-normal">
          · {complete ? "ready" : `${embedded.toLocaleString()} of ${total.toLocaleString()} snips`}
        </span>
      </h2>
      <p className="muted mb-3 text-xs">
        Powers “Similar snips” and smart search — finds ideas you phrased differently. Runs locally on your CPU;
        nothing is uploaded.
      </p>

      {(job.running || (embedded > 0 && !complete)) && (
        <div className="mb-2 h-2 rounded-sm" style={{ background: "var(--grid)" }}>
          <div
            className="h-2 rounded-sm transition-all"
            style={{ width: `${Math.max(2, pct)}%`, background: "var(--series-1)" }}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs">
        {job.running ? (
          <>
            <span className="ink-2">
              Building… {job.done.toLocaleString()} / {job.total.toLocaleString()} · {job.speed ?? "gentle"}
            </span>
            <button className="link" onClick={() => postJson("/api/embeddings/stop", {}).then(load)}>
              Stop (progress is kept)
            </button>
          </>
        ) : (
          <>
            {/* A full rebuild next to a finished index is 45 minutes one click
                away, and it is never what someone means by accident. */}
            <button
              className="card px-2 py-1 hover:opacity-80 disabled:opacity-50"
              onClick={() => {
                if (complete && !confirmRebuild) {
                  setConfirmRebuild(true);
                  return;
                }
                setConfirmRebuild(false);
                void build();
              }}
              disabled={busy}
            >
              {embedded === 0
                ? "Build index"
                : complete
                  ? confirmRebuild
                    ? `Re-embed all ${total.toLocaleString()}? This takes a while`
                    : "Rebuild"
                  : `Resume (${pending.toLocaleString()} left)`}
            </button>
            {confirmRebuild && (
              <button className="link" onClick={() => setConfirmRebuild(false)}>
                Cancel
              </button>
            )}
            {!complete && (
              <select
                value={speed}
                onChange={(e) => setSpeed(e.target.value as EmbedSpeed)}
                className="card px-2 py-1"
                title={SPEEDS.find((s) => s.key === speed)?.hint}
              >
                {SPEEDS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        {job.error && <span style={{ color: "var(--delta-down, #b00)" }}>{job.error}</span>}
        {embedded === 0 && !job.running && (
          <span className="muted">First build downloads a ~25 MB model, then takes a few minutes.</span>
        )}
        {embedded > 0 && !complete && !job.running && (
          <span className="muted">Snips added since the last build. These are embedded on their own after a sync — the button just starts it sooner.</span>
        )}
      </div>
    </div>
  );
}
