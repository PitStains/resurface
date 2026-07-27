import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { api, postSync, type ChangelogEntry, type Meta } from "./api.ts";
import AskPage from "./pages/AskPage.tsx";
import ReviewPage from "./pages/ReviewPage.tsx";
import DigestPage from "./pages/DigestPage.tsx";
import CategoriesPage from "./pages/CategoriesPage.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import EpisodePage from "./pages/EpisodePage.tsx";
import FavoritesPage from "./pages/FavoritesPage.tsx";
import Library from "./pages/Library.tsx";
import MapPage from "./pages/MapPage.tsx";
import MentionsPage from "./pages/MentionsPage.tsx";
import SearchPage from "./pages/SearchPage.tsx";
import ShowPage from "./pages/ShowPage.tsx";
import TagPage from "./pages/TagPage.tsx";
import TagsPage from "./pages/TagsPage.tsx";
import TopicsPage from "./pages/TopicsPage.tsx";
import WrappedPage from "./pages/Wrapped.tsx";
import ServerBanner from "./components/ServerBanner.tsx";
import SetupScreen from "./components/SetupScreen.tsx";
import WhatsNew from "./components/WhatsNew.tsx";
import { BookmarksProvider } from "./favorites.tsx";

/**
 * Two rows, split by what you're doing rather than cut arbitrarily in half.
 * The top row is the handful of things done daily — ask something, review what
 * came back, see the week. The second row is where you go to browse or explore,
 * which is a different mode and much less frequent.
 */
const primaryNav = [
  { to: "/", label: "Dashboard" },
  { to: "/search", label: "Search" },
  { to: "/ask", label: "Ask" },
  { to: "/review", label: "Review" },
  { to: "/digest", label: "This week" },
];

const browseNav = [
  { to: "/library", label: "Library" },
  { to: "/favorites", label: "Starred" },
  { to: "/tags", label: "Tags" },
  { to: "/mentions", label: "Mentions" },
  { to: "/topics", label: "Topics" },
  { to: "/categories", label: "Categories" },
  { to: "/map", label: "Map" },
  { to: "/wrapped", label: "Wrapped" },
];

export default function App() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);
  const [showNews, setShowNews] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  useEffect(() => {
    api<Meta>("/api/meta").then(setMeta).catch(() => {});
    api<ChangelogEntry[]>("/api/changelog").then(setChangelog).catch(() => {});
  }, []);

  // Press "/" anywhere to jump to search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        e.preventDefault();
        navigate("/search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  useEffect(() => {
    if (!meta || changelog.length === 0) return;
    const seen = localStorage.getItem("resurface.lastSeenVersion");
    // "What's new" is for people who knew what was old. On a first run it just
    // hands a stranger a changelog for a product they have not seen yet.
    if (seen === null) {
      localStorage.setItem("resurface.lastSeenVersion", meta.version);
      return;
    }
    if (seen !== meta.version) setShowNews(true);
  }, [meta, changelog]);

  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await postSync();
      setSyncMsg(
        r.error ? String(r.error) : `${r.filesParsed} updated, ${r.snipsNew} new snips`
      );
      setMeta(await api<Meta>("/api/meta"));
      window.dispatchEvent(new Event("resurface:synced"));
    } catch {
      setSyncMsg("sync failed");
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(null), 6000);
    }
  }

  // Before a vault is chosen there is nothing behind any of these links: the
  // routes are replaced by the setup screen, so every one of them is a control
  // that visibly does nothing. Sync has nothing to sync, too.
  const needsSetup = !!meta && !meta.vaultPath;

  return (
    <div className="min-h-screen">
      {/* First tab stop on every page: thirteen nav links is a lot to tab
          through before reaching the content. */}
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <ServerBanner />
      {/* Two rows of navigation wrap to ~220px on a phone, so it only sticks
          where it costs little; on a narrow screen it scrolls away instead of
          holding a quarter of the viewport. */}
      <header
        className="z-10 border-b hairline sm:sticky sm:top-0"
        style={{ background: "var(--surface-1)" }}
      >
        <div className="mx-auto max-w-6xl px-4 pt-3 pb-2">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="text-lg font-semibold tracking-tight">Resurface</span>
            <nav aria-label="Main" className="flex flex-wrap gap-1">
              {(needsSetup ? [] : primaryNav).map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.to === "/"}
                  className={({ isActive }) =>
                    `rounded-md px-3 py-1.5 text-sm ${isActive ? "font-semibold" : "ink-2 hover:underline"}`
                  }
                  style={({ isActive }) => (isActive ? { background: "var(--series-1-soft)" } : {})}
                >
                  {n.label}
                </NavLink>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-3 text-sm">
              {syncMsg && <span className="muted">{syncMsg}</span>}
              {!needsSetup && (
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className="card px-3 py-1.5 text-sm hover:opacity-80 disabled:opacity-50"
                >
                  {syncing ? "Syncing…" : "Sync now"}
                </button>
              )}
              {meta && (
                <button className="muted text-xs" onClick={() => setShowNews(true)} title="What's new">
                  v{meta.version}
                </button>
              )}
            </div>
          </div>

          {/* Browsing is a different mode from the daily loop, so it sits on
              its own line, quieter, rather than competing for the same row. */}
          <nav aria-label="Browse" className="mt-1 flex flex-wrap gap-1">
            {(needsSetup ? [] : browseNav).map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  `rounded-md px-2.5 py-1 text-xs ${isActive ? "font-semibold" : "muted hover:underline"}`
                }
                style={({ isActive }) => (isActive ? { background: "var(--series-1-soft)" } : {})}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-6">
        {meta && !meta.vaultPath ? (
          <SetupScreen
            onDone={async () => {
              setMeta(await api<Meta>("/api/meta"));
              window.dispatchEvent(new Event("resurface:synced"));
            }}
          />
        ) : (
        <BookmarksProvider>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/library" element={<Library />} />
            <Route path="/shows/:id" element={<ShowPage />} />
            <Route path="/episodes/:id" element={<EpisodePage />} />
            <Route path="/favorites" element={<FavoritesPage />} />
            <Route path="/tags" element={<TagsPage />} />
            <Route path="/tags/:key" element={<TagPage />} />
            <Route path="/topics" element={<TopicsPage />} />
            <Route path="/categories" element={<CategoriesPage />} />
            <Route path="/ask" element={<AskPage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/digest" element={<DigestPage />} />
            <Route path="/map" element={<MapPage />} />
            <Route path="/mentions" element={<MentionsPage />} />
            <Route path="/wrapped" element={<WrappedPage />} />
          </Routes>
        </BookmarksProvider>
        )}
      </main>

      {showNews && meta && (
        <WhatsNew
          version={meta.version}
          entries={changelog}
          onClose={() => {
            localStorage.setItem("resurface.lastSeenVersion", meta.version);
            setShowNews(false);
          }}
        />
      )}
    </div>
  );
}
