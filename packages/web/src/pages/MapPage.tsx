import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, postJson, type MapPoint, type SearchHit, type Topic, type TopicsStatus } from "../api.ts";
import SnipCard from "../components/SnipCard.tsx";

/**
 * The library as one picture: every snip placed by meaning, colored by topic.
 * Drawn on a plain canvas — 32k points is nothing for fillRect, and it keeps
 * the app dependency-free.
 */
const PALETTE = [
  "#2a78d6", "#e07b39", "#3a9e57", "#b5487e", "#7a5cc4", "#c0483c",
  "#2f8f8a", "#a8862c", "#5a7fb5", "#8a5a3c", "#4f9d3a", "#c05a9c",
  "#6d6dc4", "#c07a2c", "#3a8fb5", "#9c5a5a", "#5aa87a", "#b56a4f",
  "#7a8fc4", "#a0a02c",
];

export default function MapPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [points, setPoints] = useState<MapPoint[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [status, setStatus] = useState<TopicsStatus | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; snip: SearchHit } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<number | null>(null);

  const load = useCallback(async () => {
    const s = await api<TopicsStatus>("/api/topics/status").catch(() => null);
    setStatus(s);
    if (s && s.clusters > 0) {
      setTopics(await api<Topic[]>("/api/topics").catch(() => []));
      setPoints(await api<MapPoint[]>("/api/map").catch(() => []));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!status?.job.running) {
      if (poll.current) window.clearInterval(poll.current);
      poll.current = null;
      return;
    }
    poll.current = window.setInterval(load, 2000);
    return () => {
      if (poll.current) window.clearInterval(poll.current);
    };
  }, [status?.job.running, load]);

  const labelOf = useMemo(() => new Map(topics.map((t) => [t.id, t.label])), [topics]);

  // Draw: selected topic in color and on top, everything else faded.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || points.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pad = 16;
    const px = (p: MapPoint) => pad + ((p.x + 1) / 2) * (w - pad * 2);
    const py = (p: MapPoint) => pad + ((1 - p.y) / 2) * (h - pad * 2);

    const draw = (p: MapPoint, dim: boolean) => {
      ctx.globalAlpha = dim ? 0.12 : p.f ? 0.95 : 0.6;
      ctx.fillStyle = dim ? "#888" : PALETTE[p.c % PALETTE.length];
      const size = p.f && !dim ? 3.5 : 2;
      ctx.fillRect(px(p) - size / 2, py(p) - size / 2, size, size);
    };
    for (const p of points) if (selected !== null && p.c !== selected) draw(p, true);
    for (const p of points) if (selected === null || p.c === selected) draw(p, false);
    ctx.globalAlpha = 1;
  }, [points, selected]);

  async function pick(clientX: number, clientY: number, forClick: boolean) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const pad = 16;
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    let best: MapPoint | null = null;
    let bestD = 100; // px² threshold
    for (const p of points) {
      if (selected !== null && p.c !== selected) continue;
      const dx = pad + ((p.x + 1) / 2) * (w - pad * 2) - mx;
      const dy = pad + ((1 - p.y) / 2) * (h - pad * 2) - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) {
      if (!forClick) setHover(null);
      return;
    }
    const [snip] = await api<SearchHit[]>(`/api/snips/${best.id}/hydrate`).catch(() => []);
    if (snip) setHover({ x: mx, y: my, snip });
  }

  async function build() {
    setBusy(true);
    try {
      await postJson("/api/topics/build", {});
      await load();
    } finally {
      setBusy(false);
    }
  }

  const ready = (status?.clusters ?? 0) > 0;
  const noVectors = (status?.vectors ?? 0) === 0;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Map</h1>
        {ready && (
          <select
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value === "" ? null : Number(e.target.value))}
            className="card px-2 py-1 text-sm"
          >
            <option value="">All topics ({topics.length})</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} ({t.size.toLocaleString()})
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-3 text-xs">
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
              {ready ? "Rebuild topics" : "Build topics"}
            </button>
          )}
          <Link to="/topics" className="link">
            Topic list →
          </Link>
        </div>
      </div>

      {noVectors && (
        <p className="muted mb-3 text-sm">
          The map needs the meaning index — build it on the dashboard first.
        </p>
      )}

      <div className="card relative p-2">
        <canvas
          ref={canvasRef}
          className="w-full cursor-crosshair"
          style={{ height: "62vh" }}
          onMouseMove={(e) => void pick(e.clientX, e.clientY, false)}
          onMouseLeave={() => setHover(null)}
        />
        {hover && (
          <div
            className="card pointer-events-none absolute max-w-sm p-2 text-xs shadow-lg"
            style={{
              left: Math.min(hover.x + 12, (canvasRef.current?.clientWidth ?? 400) - 260),
              top: hover.y + 12,
              background: "var(--surface-1)",
            }}
          >
            <div className="font-medium">{hover.snip.showTitle}</div>
            <div className="ink-2">{hover.snip.title}</div>
            <div className="muted mt-1">{labelOf.get(points.find((p) => p.id === hover.snip.id)?.c ?? -1)}</div>
          </div>
        )}
        {points.length > 0 && (
          <p className="muted p-2 text-xs">
            {points.length.toLocaleString()} snips placed by meaning · brighter squares are ⭐ Snipd favorites · hover a
            point for its snip. Neighbors here are neighbors in meaning; distance across the whole map is only a rough
            guide.
          </p>
        )}
      </div>

      {selected !== null && <TopicPreview id={selected} />}
    </div>
  );
}

/** The chosen topic's most central snips, right under the map. */
function TopicPreview({ id }: { id: number }) {
  const [snips, setSnips] = useState<SearchHit[]>([]);
  useEffect(() => {
    api<{ snips: SearchHit[]; total: number }>(`/api/topics/${id}/snips?limit=5`)
      .then((r) => setSnips(r.snips))
      .catch(() => setSnips([]));
  }, [id]);
  return (
    <div className="mt-4 space-y-3">
      <h2 className="text-sm font-semibold">Most typical snips in this topic</h2>
      {snips.map((s) => (
        <SnipCard key={s.id} snip={s} />
      ))}
    </div>
  );
}
