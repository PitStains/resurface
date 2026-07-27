import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  api,
  del,
  postJson,
  type EmbedStatus,
  type Meta,
  type SavedSearch,
  type SearchMode,
  type SearchResult,
  type ShowListItem,
} from "../api.ts";
import SnipCard from "../components/SnipCard.tsx";
import TagChip from "../components/TagChip.tsx";

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [shows, setShows] = useState<ShowListItem[]>([]);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [show, setShow] = useState("");
  const [sort, setSort] = useState("relevance");
  const [favOnly, setFavOnly] = useState(false);
  const [hasQuote, setHasQuote] = useState(false);
  // Deep-linkable, so "browse the ones you made" can point straight here.
  const [kind, setKind] = useState<"" | "auto" | "manual">(
    (params.get("kind") as "" | "auto" | "manual") ?? ""
  );
  const [tags, setTags] = useState<string[]>(
    (params.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean)
  );
  const [tagMode, setTagMode] = useState<"any" | "all">("any");
  const [mode, setMode] = useState<SearchMode>(
    (localStorage.getItem("resurface.searchMode") as SearchMode) || "hybrid"
  );
  const [embed, setEmbed] = useState<EmbedStatus | null>(null);
  const [limit, setLimit] = useState(25);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<ShowListItem[]>("/api/shows").then(setShows);
    api<SavedSearch[]>("/api/saved-searches").then(setSaved);
    api<Meta>("/api/meta").then(setMeta).catch(() => {});
    api<EmbedStatus>("/api/embeddings/status").then(setEmbed).catch(() => {});
    inputRef.current?.focus();
  }, []);

  const smartReady = (embed?.embedded ?? 0) > 0;

  const toggleTag = (key: string) =>
    setTags((prev) => (prev.includes(key) ? prev.filter((t) => t !== key) : [...prev, key]));

  const queryParams = useCallback(
    (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams({ q, sort, mode, ...extra });
      if (show) p.set("show", show);
      if (favOnly) p.set("starred", "1");
      if (hasQuote) p.set("hasQuote", "1");
      if (kind) p.set("kind", kind);
      if (tags.length) {
        p.set("tags", tags.join(","));
        p.set("tagMode", tagMode);
      }
      return p;
    },
    [q, sort, mode, show, favOnly, hasQuote, kind, tags, tagMode]
  );

  const runSearch = useCallback(
    (lim: number) => {
      // A filter alone is a valid query: with no text, tags or "made by me"
      // browse their own matches rather than showing an empty page.
      if (q.trim() === "" && tags.length === 0 && !kind) {
        setResult(null);
        return;
      }
      api<SearchResult>(`/api/search?${queryParams({ limit: String(lim) })}`).then((r) => {
        setResult(r);
        // A smart query answered in keyword mode means the index is missing or
        // still building — refresh so the note below says which.
        if (mode !== "keyword" && r.mode === "keyword")
          api<EmbedStatus>("/api/embeddings/status").then(setEmbed).catch(() => {});
      });
    },
    [q, tags, kind, mode, queryParams]
  );

  useEffect(() => {
    const t = setTimeout(() => {
      runSearch(limit);
      const next: Record<string, string> = {};
      if (q) next.q = q;
      if (tags.length) next.tags = tags.join(",");
      if (kind) next.kind = kind; // keep the filter shareable in the URL
      setParams(next, { replace: true });
    }, 200);
    return () => clearTimeout(t);
  }, [runSearch, limit, setParams, q, tags, kind]);

  async function saveCurrentSearch() {
    const name = prompt("Name this search:", q || `#${tags.join(" #")}`);
    if (!name) return;
    await postJson("/api/saved-searches", {
      name,
      q,
      filters: { show: show || undefined, starredOnly: favOnly, hasQuote, kind: kind || undefined, tags, tagMode },
    });
    setSaved(await api<SavedSearch[]>("/api/saved-searches"));
  }

  async function openSaved(s: SavedSearch) {
    setQ(s.query.q);
    setShow((s.query.filters.show as string) ?? "");
    setFavOnly(Boolean(s.query.filters.starredOnly));
    setHasQuote(Boolean(s.query.filters.hasQuote));
    setKind((s.query.filters.kind as "" | "auto" | "manual") ?? "");
    setTags((s.query.filters.tags as string[]) ?? []);
    setTagMode(s.query.filters.tagMode === "all" ? "all" : "any");
    await postJson(`/api/saved-searches/${s.id}/seen`, {});
    setSaved(await api<SavedSearch[]>("/api/saved-searches"));
  }

  const exportUrl = (format: string) => `/api/export/search?${queryParams({ format })}`;

  return (
    <div>
      {/* The search box is self-evident on screen, but the page still needs a
          heading to announce itself to a screen reader. */}
      <h1 className="sr-only">Search</h1>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${(meta?.totals.snips ?? 0).toLocaleString()} snips… (words from a quote, or tag:yourtag)`}
          className="card w-full max-w-xl px-4 py-2 text-sm outline-none"
        />
        <select value={show} onChange={(e) => setShow(e.target.value)} className="card px-2 py-2 text-sm">
          <option value="">All shows</option>
          {shows.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} className="card px-2 py-2 text-sm">
          <option value="relevance">Relevance</option>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
        </select>
        <select
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as SearchMode);
            localStorage.setItem("resurface.searchMode", e.target.value);
          }}
          className="card px-2 py-2 text-sm"
          title={
            smartReady
              ? "Keyword: exact words. Smart: words + meaning. Meaning only: ignores wording entirely."
              : "Build the meaning index on the dashboard to enable smart search"
          }
        >
          <option value="hybrid">Smart{smartReady ? "" : " (needs index)"}</option>
          <option value="keyword">Keyword</option>
          <option value="semantic">Meaning only{smartReady ? "" : " (needs index)"}</option>
        </select>
        <label className="flex cursor-pointer items-center gap-1 text-sm ink-2">
          <input type="checkbox" checked={favOnly} onChange={(e) => setFavOnly(e.target.checked)} /> ⭐/🔖 only
        </label>
        <label className="flex cursor-pointer items-center gap-1 text-sm ink-2">
          <input type="checkbox" checked={hasQuote} onChange={(e) => setHasQuote(e.target.checked)} /> has quote
        </label>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as "" | "auto" | "manual")}
          className="card px-2 py-1 text-sm"
          aria-label="Who made the snip"
          title="Snips Snipd made from its template, versus ones you made yourself. A filter only — it never changes ranking."
        >
          <option value="">Anyone's snips</option>
          <option value="manual">Made by me</option>
          <option value="auto">Auto-generated</option>
        </select>
        <span className="muted text-xs">⭐ = Snipd favorite · 🔖 = bookmark</span>
      </div>

      {(result?.facets.length ?? 0) > 0 || tags.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="muted text-xs">Tags:</span>
          {tags
            .filter((t) => !(result?.facets ?? []).some((f) => f.key === t))
            .map((t) => (
              <TagChip key={t} label={t} active onClick={() => toggleTag(t)} />
            ))}
          {result?.facets.map((f) => (
            <TagChip
              key={f.key}
              label={f.label}
              count={f.count}
              active={tags.includes(f.key)}
              onClick={() => toggleTag(f.key)}
            />
          ))}
          {tags.length > 1 && (
            <button
              className="muted text-xs underline"
              onClick={() => setTagMode(tagMode === "any" ? "all" : "any")}
              title="Match snips carrying any of the selected tags, or all of them"
            >
              match {tagMode}
            </button>
          )}
          {tags.length > 0 && (
            <button className="muted text-xs underline" onClick={() => setTags([])}>
              clear
            </button>
          )}
        </div>
      ) : null}

      {saved.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="muted">Saved:</span>
          {saved.map((s) => (
            <span key={s.id} className="card flex items-center gap-1 px-2 py-1">
              <button className="link" onClick={() => openSaved(s)}>
                {s.name}
              </button>
              {s.newCount > 0 && (
                <span className="rounded-full px-1.5 font-semibold" style={{ background: "var(--series-1-soft)" }}>
                  {s.newCount} new
                </span>
              )}
              <button
                className="muted hover:opacity-70"
                title="Delete saved search"
                onClick={async () => {
                  await del(`/api/saved-searches/${s.id}`);
                  setSaved(await api<SavedSearch[]>("/api/saved-searches"));
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {result && (
        <div className="mb-3 flex flex-wrap items-center gap-3 text-xs muted">
          <span title="Keyword counts every snip containing your words; the smart modes rank the closest matches instead, so their counts aren't corpus-wide totals.">
            {result.mode === "keyword" && `${result.total.toLocaleString()} results`}
            {result.mode === "hybrid" &&
              `top ${result.total.toLocaleString()} blended from ${(result.keywordTotal ?? 0).toLocaleString()} word matches + closest by meaning`}
            {result.mode === "semantic" &&
              `${result.total.toLocaleString()} closest by meaning · ${(result.keywordTotal ?? 0).toLocaleString()} contain your words`}
            {" in "}
            {result.tookMs} ms
          </span>
          {mode !== "keyword" && result.mode === "keyword" && (
            <span style={{ color: "var(--series-1)" }}>
              Ran as keyword — build the meaning index on the dashboard to enable {mode === "semantic" ? "meaning" : "smart"} search.
            </span>
          )}
          {result.mode !== "keyword" && (result.indexed ?? 0) < (result.indexTotal ?? 0) && (
            <span className="muted">
              meaning index {Math.round(((result.indexed ?? 0) / (result.indexTotal || 1)) * 100)}% built
            </span>
          )}
          <button className="link" onClick={saveCurrentSearch}>
            Save this search
          </button>
          <span>
            Export: <a className="link" href={exportUrl("md")}>MD</a> ·{" "}
            <a className="link" href={exportUrl("csv")}>CSV</a> ·{" "}
            <a className="link" href={exportUrl("json")}>JSON</a>
          </span>
        </div>
      )}

      <div className="space-y-3">
        {result?.hits.map((h) => (
          <SnipCard key={h.id} snip={h} onTagClick={toggleTag} activeTags={tags} showRelated={smartReady} />
        ))}
      </div>

      {result && result.hits.length < result.total && (
        <button className="mt-4 text-sm link" onClick={() => setLimit(limit + 25)}>
          Show more ({result.total - result.hits.length} remaining)
        </button>
      )}
      {result === null && (
        <p className="muted mt-8 text-center text-sm">
          Type to search everything you've ever snipped. Tip: press <kbd>/</kbd> anywhere to jump here, or filter by a
          Snipd tag with <code>tag:chat</code>.
        </p>
      )}
      {result !== null && result.total === 0 && <p className="muted mt-8 text-center text-sm">No snips match.</p>}
    </div>
  );
}
