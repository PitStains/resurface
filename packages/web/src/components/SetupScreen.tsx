import { useEffect, useState } from "react";
import { api, postJson } from "../api.ts";

interface Detect {
  candidates: string[];
  ignoredBackups: string[];
}

export default function SetupScreen({ onDone }: { onDone: () => void }) {
  const [detect, setDetect] = useState<Detect | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Detect>("/api/setup/detect").then((d) => {
      setDetect(d);
      if (d.candidates.length > 0) setPath(d.candidates[0]);
    });
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ error?: string; imported?: { totals: { snips: number } } | null }>("/api/setup", {
        vaultPath: path,
      });
      if (r.error) setError(r.error);
      else onDone();
    } catch (err) {
      // The server says which of the two problems it is — a path that isn't
      // there, or a path that is but holds no Snipd export. Those need
      // different fixes, so pass its words through rather than guessing.
      const said = err instanceof Error ? err.message : "";
      setError(said || "Import failed — check the path and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <div className="card p-8">
        <h1 className="mb-2 text-xl font-semibold">Welcome to Resurface</h1>
        <p className="ink-2 mb-4 text-sm">
          Point Resurface at your Snipd export folder — the one the{" "}
          <a className="link" href="https://www.snipd.com/blog/sync-snips-to-obsidian-plugin" target="_blank" rel="noreferrer">
            Snipd Obsidian plugin
          </a>{" "}
          syncs to. You can paste the vault root or the <code>Snipd\Data</code> folder itself; your files are only
          ever read, never modified.
        </p>

        {detect && detect.candidates.length > 0 && (
          <div className="mb-3">
            <div className="muted mb-1 text-xs">Detected on this machine:</div>
            {detect.candidates.map((c) => (
              <button
                key={c}
                onClick={() => setPath(c)}
                className={`mb-1 block w-full truncate rounded-md px-3 py-2 text-left text-xs ${path === c ? "font-semibold" : "ink-2"}`}
                style={path === c ? { background: "var(--series-1-soft)" } : { background: "transparent" }}
                title={c}
              >
                {c}
              </button>
            ))}
          </div>
        )}
        {detect && detect.ignoredBackups.length > 0 && (
          <p className="muted mb-3 text-xs">Backup folders were detected and ignored: {detect.ignoredBackups.join("; ")}</p>
        )}

        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="C:\Users\you\Documents\Obsidian Vault\Snipd"
          className="card mb-3 w-full px-3 py-2 text-sm outline-none"
          style={{ fontFamily: "monospace" }}
        />
        {error && <p className="mb-3 text-sm" style={{ color: "#d03b3b" }}>{error}</p>}
        <button
          onClick={submit}
          disabled={busy || path.trim() === ""}
          className="rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
          style={{ background: "var(--series-1)", color: "#fff" }}
        >
          {busy ? "Importing your library — this can take a minute…" : "Import my snips"}
        </button>
      </div>
    </div>
  );
}
