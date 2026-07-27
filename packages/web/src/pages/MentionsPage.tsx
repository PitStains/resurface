import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Book, type MentionEpisode, type Person } from "../api.ts";
import { fmtDate } from "../format.ts";

function EpisodeList({ path }: { path: string }) {
  const [eps, setEps] = useState<MentionEpisode[] | null>(null);
  useEffect(() => {
    api<MentionEpisode[]>(path).then(setEps);
  }, [path]);
  if (!eps) return <p className="muted p-2 text-xs">Loading…</p>;
  return (
    <ul className="space-y-1 p-2 pl-8 text-sm">
      {eps.map((e) => (
        <li key={e.id} className="truncate">
          <Link to={`/episodes/${e.id}`} className="link">
            {e.title}
          </Link>
          <span className="muted text-xs"> — {e.showTitle} · {fmtDate(e.lastSnipDate)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function MentionsPage() {
  const [tab, setTab] = useState<"books" | "people">("books");
  const [books, setBooks] = useState<Book[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api<Book[]>("/api/books").then(setBooks);
    api<Person[]>("/api/people").then(setPeople);
  }, []);

  const filteredBooks = useMemo(
    () => books.filter((b) => (b.title + " " + (b.author ?? "")).toLowerCase().includes(q.toLowerCase())),
    [books, q]
  );
  const filteredPeople = useMemo(
    () => people.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())),
    [people, q]
  );

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Mentions</h1>
        <div className="flex gap-1">
          {(["books", "people"] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setOpen(null);
              }}
              className={`rounded-md px-3 py-1.5 text-sm capitalize ${tab === t ? "font-semibold" : "ink-2"}`}
              style={tab === t ? { background: "var(--series-1-soft)" } : {}}
            >
              {t} ({t === "books" ? books.length : people.length})
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Filter ${tab}…`}
          className="card ml-auto w-56 px-3 py-1.5 text-sm outline-none"
        />
      </div>
      <p className="muted mb-3 text-xs">
        {tab === "books"
          ? "Every book mentioned across your snipped episodes — your podcast-sourced reading list."
          : "Every guest across your snipped episodes."}
      </p>

      <div className="space-y-1">
        {tab === "books"
          ? filteredBooks.map((b) => (
              <div key={b.id} className="card">
                <button
                  className="flex w-full items-baseline gap-2 p-3 text-left"
                  onClick={() => setOpen(open === b.id ? null : b.id)}
                >
                  <span className="text-sm font-medium">{b.title}</span>
                  {b.author && <span className="ink-2 text-xs">by {b.author}</span>}
                  <span className="muted ml-auto shrink-0 text-xs" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {b.mentions} {b.mentions === 1 ? "mention" : "mentions"} · {b.shows} {b.shows === 1 ? "show" : "shows"} · {fmtDate(b.lastMention)}
                  </span>
                  {b.url && (
                    <a href={b.url} target="_blank" rel="noreferrer" className="link shrink-0 text-xs" onClick={(e) => e.stopPropagation()}>
                      Snipd ↗
                    </a>
                  )}
                </button>
                {open === b.id && <EpisodeList path={`/api/books/${b.id}/episodes`} />}
              </div>
            ))
          : filteredPeople.map((p) => (
              <div key={p.id} className="card">
                <button
                  className="flex w-full items-baseline gap-2 p-3 text-left"
                  onClick={() => setOpen(open === p.id ? null : p.id)}
                >
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className="muted ml-auto shrink-0 text-xs" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {p.episodes} {p.episodes === 1 ? "episode" : "episodes"} · {p.shows} {p.shows === 1 ? "show" : "shows"} · {fmtDate(p.lastSeen)}
                  </span>
                  {p.url && (
                    <a href={p.url} target="_blank" rel="noreferrer" className="link shrink-0 text-xs" onClick={(e) => e.stopPropagation()}>
                      Snipd ↗
                    </a>
                  )}
                </button>
                {open === p.id && <EpisodeList path={`/api/people/${p.id}/episodes`} />}
              </div>
            ))}
      </div>
    </div>
  );
}
