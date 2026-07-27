import { useEffect, useState } from "react";
import { api, onServerReachability } from "../api.ts";

/**
 * A blank page is the worst possible way to report "the server stopped
 * answering", and it is what every page did: each one fetches and renders
 * whatever comes back, so when nothing comes back they render nothing, forever,
 * with no hint that the data is fine and only the connection is gone.
 *
 * This says so instead, and keeps checking so it clears itself the moment the
 * server is back — no reload needed to find out.
 */
export default function ServerBanner() {
  const [down, setDown] = useState(false);

  useEffect(() => onServerReachability((reachable) => setDown(!reachable)), []);

  useEffect(() => {
    if (!down) return;
    const id = setInterval(() => {
      // Any answer at all clears the banner, via the reachability listener.
      api("/api/meta", { timeoutMs: 4000 }).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [down]);

  if (!down) return null;

  return (
    <div
      role="alert"
      className="border-b px-4 py-3 text-sm"
      style={{ background: "var(--warn-soft)", color: "var(--warn-ink)" }}
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1">
        <strong>Resurface isn&rsquo;t responding.</strong>
        <span>
          Your library is safe — this is the connection to the app, not your data. Check the window
          that started it: if its title says <em>Select</em>, press <kbd>Esc</kbd> in it. Otherwise
          run <code>Start Resurface.bat</code> again.
        </span>
        <button className="ml-auto underline" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}
