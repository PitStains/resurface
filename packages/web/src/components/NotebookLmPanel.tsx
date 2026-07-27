import { useEffect, useState } from "react";
import { api, postJson, LONG_TIMEOUT_MS, type PackPlan, type PackResult } from "../api.ts";

const GROUPS = [
  { value: "show", label: "One file per show", hint: "answers cite the show they came from" },
  { value: "category", label: "One file per category", hint: "answers cite the topic" },
  { value: "flat", label: "Split by date only", hint: "fewest files, vaguest citations" },
];
const SCOPES = [
  { value: "all", label: "Everything" },
  { value: "starred", label: "Starred in Snipd" },
  { value: "manual", label: "Snips I made by hand" },
  { value: "auto", label: "Snips Snipd made" },
];

const n = (x: number) => x.toLocaleString();

/**
 * NotebookLM cannot be connected to. Its consumer product has no API — the one
 * Google publishes is for the Enterprise edition on Google Cloud, behind a paid
 * licence — so nothing can push sources into notebooklm.google.com on your
 * behalf. Sources are added by hand, in the browser, and that is the whole
 * reason this panel exists: to make the by-hand part a drag-and-drop rather
 * than an afternoon of splitting files.
 */
export default function NotebookLmPanel() {
  const [group, setGroup] = useState("show");
  const [scope, setScope] = useState("all");
  const [full, setFull] = useState(false);
  const [maxWords, setMaxWords] = useState(400_000);
  const [plan, setPlan] = useState<PackPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PackResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPlanning(true);
    const q = `group=${group}&scope=${scope}&include=${full ? "full" : "notes"}&maxWords=${maxWords}`;
    api<PackPlan>(`/api/export/notebooklm/plan?${q}`, { timeoutMs: LONG_TIMEOUT_MS })
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch(() => {
        if (!cancelled) setPlan(null);
      })
      .finally(() => {
        if (!cancelled) setPlanning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, group, scope, full, maxWords]);

  async function create() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await postJson<PackResult>(
          "/api/export/notebooklm",
          { group, scope, include: full ? "full" : "notes", maxWords },
          { timeoutMs: LONG_TIMEOUT_MS }
        )
      );
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "The export failed.");
    } finally {
      setBusy(false);
    }
  }

  const sources = plan ? plan.files.length + 1 : 0;

  return (
    <section className="card p-4">
      <button
        className="flex w-full items-center justify-between text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>
          <span className="font-semibold">Package this library for NotebookLM</span>
          <span className="muted ml-2 text-sm">
            files sized and named for a NotebookLM import
          </span>
        </span>
        <span className="muted text-sm">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="mt-4 space-y-4 text-sm">
          <p className="ink-2">
            NotebookLM has no API for personal accounts, so nothing can add sources for you — you
            upload them yourself, once. This writes a folder of Markdown files that are already
            inside NotebookLM&rsquo;s limits, named so its citations tell you where an answer came
            from, with written instructions beside them.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="muted block text-xs uppercase tracking-wide">What to include</span>
              <select
                className="card mt-1 w-full px-2 py-1.5"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                {SCOPES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="muted block text-xs uppercase tracking-wide">How to split it</span>
              <select
                className="card mt-1 w-full px-2 py-1.5"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
              >
                {GROUPS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
              <span className="muted mt-1 block text-xs">
                {GROUPS.find((g) => g.value === group)?.hint}
              </span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} />
              <span>Include transcripts</span>
              <span className="muted text-xs">(~3.5&times; the words, verbatim detail)</span>
            </label>
            <label className="flex items-center gap-2">
              <span>Words per file</span>
              <input
                type="number"
                className="card w-28 px-2 py-1"
                min={10000}
                max={500000}
                step={10000}
                value={maxWords}
                onChange={(e) => setMaxWords(Number(e.target.value) || 400_000)}
              />
              <span className="muted text-xs">NotebookLM&rsquo;s ceiling is 500,000</span>
            </label>
          </div>

          <div className="hairline border-t pt-3">
            {planning && <p className="muted">Working out the split&hellip;</p>}
            {plan && !planning && (
              <div className="space-y-2">
                <p>
                  <strong>{n(sources)} files</strong> &middot; {n(plan.totalSnips)} snips &middot;{" "}
                  {n(plan.totalWords)} words
                </p>
                <p className="muted text-xs">
                  Fits:{" "}
                  {[
                    { ok: plan.fits.free, label: "Free (50)" },
                    { ok: plan.fits.pro, label: "Pro (300)" },
                    { ok: plan.fits.ultra, label: "Ultra (600)" },
                  ].map((p, i) => (
                    <span key={p.label}>
                      {i > 0 ? " · " : ""}
                      {p.ok ? p.label : <s>{p.label}</s>}
                    </span>
                  ))}
                </p>
                {plan.notes.map((note) => (
                  <p key={note} className="text-xs" style={{ color: "var(--warn-ink)" }}>
                    {note}
                  </p>
                ))}
                <details>
                  <summary className="muted cursor-pointer text-xs">
                    See the {n(plan.files.length)} source files (the guide makes {n(sources)})
                  </summary>
                  <ul className="muted mt-2 max-h-52 overflow-y-auto text-xs">
                    {plan.files.map((f) => (
                      <li key={f.name}>
                        {f.name} &middot; {n(f.snips)} snips &middot; {n(f.words)} words
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              className="card px-3 py-1.5 hover:opacity-80 disabled:opacity-50"
              onClick={create}
              disabled={busy || !plan || plan.totalSnips === 0}
            >
              {busy ? "Writing the files…" : "Create the import folder"}
            </button>
            {error && <span style={{ color: "var(--warn-ink)" }}>{error}</span>}
          </div>

          {result && (
            <div className="space-y-1">
              <p>
                Wrote {n(result.files.length + 1)} files. The folder should have opened; it is at:
              </p>
              <p className="break-all font-mono text-xs">{result.dir}</p>
              <p className="muted text-xs">
                Open <strong>HOW-TO-IMPORT.md</strong> there for the steps, then upload everything
                inside the <strong>sources</strong> folder.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
