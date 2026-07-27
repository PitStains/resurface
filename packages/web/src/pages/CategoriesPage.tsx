import { useCallback, useEffect, useState } from "react";
import { api, del, postJson, request, type CategoriesStatus, type Category, type SearchHit } from "../api.ts";
import SnipCard from "../components/SnipCard.tsx";

async function patch(path: string, body: unknown) {
  await request(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Categories are yours: seeded from discovered topics, then renamed, merged and
 * corrected. Corrections are permanent — re-assignment never overwrites a snip
 * you placed by hand, and your picks define what the category means next time.
 */
export default function CategoriesPage() {
  const [cats, setCats] = useState<Category[]>([]);
  const [status, setStatus] = useState<CategoriesStatus | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setCats(await api<Category[]>("/api/categories").catch(() => []));
    setStatus(await api<CategoriesStatus>("/api/categories/status").catch(() => null));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try {
      await fn();
      await load();
    } finally {
      setBusy(null);
    }
  }

  const empty = cats.length === 0;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Categories</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          <button
            className="card px-2 py-1 hover:opacity-80 disabled:opacity-50"
            disabled={!!busy}
            onClick={() => run("seed", () => postJson("/api/categories/seed", {}))}
          >
            {busy === "seed" ? "Seeding…" : "Seed from topics"}
          </button>
          <button
            className="card px-2 py-1 hover:opacity-80 disabled:opacity-50"
            disabled={!!busy || empty}
            onClick={() => run("assign", () => postJson("/api/categories/assign", {}))}
          >
            {busy === "assign" ? "Assigning…" : "Re-assign all snips"}
          </button>
          <button
            className="card px-2 py-1 hover:opacity-80 disabled:opacity-50"
            disabled={!!busy}
            onClick={() => {
              const name = prompt("New category name:");
              if (name?.trim()) void run("new", () => postJson("/api/categories", { name }));
            }}
          >
            New
          </button>
        </div>
      </div>
      <p className="muted mb-4 text-xs">
        Your own taxonomy, seeded from the topics Resurface discovered. Rename anything, merge duplicates, and pin or
        remove individual snips — pinned snips define what the category means, and re-assigning never undoes them.
        {status &&
          ` ${status.assigned.toLocaleString()} snips categorized, ${status.uncategorized.toLocaleString()} not yet (cutoff ${status.threshold}).`}
      </p>

      {empty && (
        <div className="card p-8 text-center">
          <p className="mb-1 text-sm font-medium">No categories yet</p>
          <p className="muted text-sm">
            Click “Seed from topics” to turn your discovered topics into an editable taxonomy, then “Re-assign all
            snips”.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {cats.map((c) => (
          <div key={c.id} className="card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === c.id ? null : c.id)}>
                <span className="text-sm font-medium">{c.name}</span>
                <span className="muted ml-2 text-xs">
                  {c.size.toLocaleString()} snips · {c.shows} shows
                  {c.favorites > 0 && ` · ${c.favorites} ⭐`}
                  {c.manual > 0 && ` · ${c.manual} pinned`}
                  {c.source === "user" && " · yours"}
                </span>
              </button>
              <div className="flex shrink-0 gap-2 text-xs">
                <button
                  className="link"
                  onClick={() => {
                    const name = prompt("Rename category:", c.name);
                    if (name?.trim()) void run("rename", () => patch(`/api/categories/${c.id}`, { name }));
                  }}
                >
                  Rename
                </button>
                <button
                  className="link"
                  onClick={() => {
                    const other = prompt(
                      `Merge “${c.name}” into which category? Type its exact name:\n\n${cats
                        .filter((x) => x.id !== c.id)
                        .map((x) => x.name)
                        .join("\n")}`
                    );
                    const target = cats.find((x) => x.name === other?.trim());
                    if (target) void run("merge", () => patch(`/api/categories/${c.id}`, { mergeInto: target.id }));
                    else if (other) alert("No category with that exact name.");
                  }}
                >
                  Merge
                </button>
                <button
                  className="muted hover:opacity-70"
                  onClick={() => {
                    if (confirm(`Delete “${c.name}”? Snips themselves are untouched.`))
                      void run("delete", () => del(`/api/categories/${c.id}`));
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
            {open === c.id && <CategorySnips id={c.id} onChange={load} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function CategorySnips({ id, onChange }: { id: number; onChange: () => void }) {
  const [snips, setSnips] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(5);

  const load = useCallback(() => {
    api<{ snips: SearchHit[]; total: number }>(`/api/categories/${id}/snips?limit=${limit}`)
      .then((r) => {
        setSnips(r.snips);
        setTotal(r.total);
      })
      .catch(() => setSnips([]));
  }, [id, limit]);
  useEffect(load, [load]);

  return (
    <div className="mt-3 space-y-3 border-t pt-3 hairline">
      {snips.map((s) => (
        <div key={s.id}>
          <SnipCard snip={s} />
          <button
            className="muted mt-1 text-xs hover:underline"
            onClick={async () => {
              await postJson(`/api/categories/${id}/snips`, { snipId: s.id, member: false });
              load();
              onChange();
            }}
          >
            Remove from this category
          </button>
        </div>
      ))}
      {snips.length < total && (
        <button className="link text-sm" onClick={() => setLimit(limit + 10)}>
          Show more ({total - snips.length} remaining)
        </button>
      )}
    </div>
  );
}
