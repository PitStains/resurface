import { useEffect, useState } from "react";
import { api, postJson, request, LONG_TIMEOUT_MS } from "../api.ts";
import { fmtDate } from "../format.ts";

interface BackupInfo {
  file: string;
  kind: "snapshot" | "work";
  sizeBytes: number;
  createdAt: string;
}
interface BackupStatus {
  dir: string;
  snapshots: BackupInfo[];
  work: BackupInfo[];
  lastSnapshotAt: string | null;
  lastWorkAt: string | null;
  totalBytes: number;
  job: { lastError: string | null; running: boolean };
  health: { ok: boolean; detail: string; checkedAt: string; suggestedBackup: string | null } | null;
}

const mb = (n: number) => `${(n / 1048576).toFixed(n < 1048576 ? 2 : 0)} MB`;

function ago(iso: string | null): string {
  if (!iso) return "never";
  const hours = (Date.now() - Date.parse(iso)) / 3600_000;
  if (hours < 1) return "less than an hour ago";
  if (hours < 24) return `${Math.round(hours)} hours ago`;
  return fmtDate(iso.slice(0, 10));
}

/**
 * Backups, and putting one back.
 *
 * Most of the library can be rebuilt from the vault, so this exists for the
 * part that cannot: the review history, bookmarks, category names and pins.
 * Restoring is deliberately a two-step confirmation — it replaces the whole
 * database — and the copy it replaces is kept rather than deleted.
 */
export default function BackupPanel() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = () => api<BackupStatus>("/api/backups").then(setStatus).catch(() => {});
  useEffect(() => {
    void refresh();
  }, []);

  async function backupNow() {
    setBusy(true);
    setMsg(null);
    try {
      // Copying and verifying a few hundred megabytes is minutes, not seconds.
      const r = await postJson<{ info: BackupInfo; verify?: { snips: number } }>("/api/backups", {}, {
        timeoutMs: LONG_TIMEOUT_MS,
      });
      setMsg(`Saved ${r.info.file} (${mb(r.info.sizeBytes)}${r.verify ? `, ${r.verify.snips.toLocaleString()} snips verified` : ""}).`);
      await refresh();
    } catch {
      setMsg("Backup failed — see the app's console for details.");
    } finally {
      setBusy(false);
    }
  }

  async function restore(file: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await request("/api/backups/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file }),
        timeoutMs: LONG_TIMEOUT_MS,
      });
      const body = (await res.json()) as { error?: string; setAside?: string };
      setMsg(
        res.ok
          ? `Restored ${file}. The database it replaced was kept in ${body.setAside}. Reload the page.`
          : `Restore refused: ${body.error}`
      );
      await refresh();
    } catch {
      setMsg("Restore failed.");
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  if (!status) return null;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Backups</h2>
        <button className="card px-2 py-1 text-xs hover:opacity-80 disabled:opacity-50" onClick={backupNow} disabled={busy}>
          {busy ? "Working…" : "Back up now"}
        </button>
      </div>

      <p className="muted mt-2 text-xs">
        Your snips can always be rebuilt from the vault — your review history, bookmarks and category names
        cannot. A small record of those is saved constantly; a full snapshot once a day. Every snapshot is
        opened and checked before it's kept.
      </p>

      <p className="mt-2 text-xs">
        Last full snapshot <span className="font-medium">{ago(status.lastSnapshotAt)}</span> · your work saved{" "}
        <span className="font-medium">{ago(status.lastWorkAt)}</span> · {mb(status.totalBytes)} in{" "}
        {status.snapshots.length + status.work.length} files
        {status.health?.ok && <> · checked and sound {ago(status.health.checkedAt)}</>}
      </p>

      {status.health && !status.health.ok && (
        <div
          className="mt-3 rounded-md p-3 text-xs"
          style={{ background: "var(--series-1-soft)", border: "1px solid var(--series-1)" }}
        >
          <p className="font-semibold">This database has a problem.</p>
          <p className="mt-1">{status.health.detail}</p>
          <p className="mt-1">
            {status.health.suggestedBackup
              ? `Restoring ${status.health.suggestedBackup} below should put it right. Your vault is untouched either way.`
              : "There's no verified snapshot to restore. Your Snipd vault is untouched — a fresh import can rebuild everything except your review history."}
          </p>
        </div>
      )}

      {status.job.lastError && (
        <p className="mt-2 text-xs" style={{ color: "var(--series-1)" }}>
          Last automatic backup failed: {status.job.lastError}
        </p>
      )}
      {msg && <p className="muted mt-2 text-xs">{msg}</p>}

      {status.snapshots.length > 0 && (
        <div className="mt-3">
          <h3 className="mb-1 text-xs font-semibold">Full snapshots</h3>
          <ul className="space-y-1">
            {status.snapshots.map((b) => (
              <li key={b.file} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate">{b.file}</span>
                <span className="muted shrink-0" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {mb(b.sizeBytes)}
                </span>
                {confirming === b.file ? (
                  <>
                    <span className="shrink-0">Replace everything with this?</span>
                    <button className="link shrink-0" onClick={() => void restore(b.file)} disabled={busy}>
                      Yes, restore
                    </button>
                    <button className="muted shrink-0" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button className="link shrink-0" onClick={() => setConfirming(b.file)} disabled={busy}>
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="muted mt-3 text-xs">
        Kept in {status.dir}. Restoring never deletes what it replaces — the old database is moved aside.
      </p>
    </div>
  );
}
