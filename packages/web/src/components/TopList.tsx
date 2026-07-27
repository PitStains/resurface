import { useState, type ReactNode } from "react";

const SIZES = [5, 10, 25];

/**
 * A ranked list that shows five by default and lets the reader open it up.
 * Every Wrapped leaderboard uses this, so "show me more" works the same way
 * everywhere and the page never dictates how deep you're allowed to look.
 */
export default function TopList<T>({
  title,
  items,
  render,
  note,
  bar,
  emptyText = "Nothing here for this period.",
}: {
  title: string;
  items: T[];
  render: (item: T, i: number) => ReactNode;
  /** Optional value used to draw a proportional bar behind each row. */
  bar?: (item: T) => number;
  note?: ReactNode;
  emptyText?: string;
}) {
  const [size, setSize] = useState(5);
  const shown = items.slice(0, size);
  const max = bar ? Math.max(1, ...items.slice(0, size).map(bar)) : 1;

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {items.length > SIZES[0] && (
          <select
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            className="card ml-auto px-2 py-1 text-xs"
            aria-label={`How many to show in ${title}`}
          >
            {SIZES.filter((s) => s <= Math.max(SIZES[0], items.length)).map((s) => (
              <option key={s} value={s}>
                Top {s}
              </option>
            ))}
            {items.length > 25 && <option value={items.length}>All {items.length}</option>}
          </select>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="muted text-sm">{emptyText}</p>
      ) : (
        <ol className={`space-y-1.5 text-sm ${size > 10 ? "max-h-96 overflow-y-auto pr-1" : ""}`}>
          {shown.map((item, i) => (
            <li key={i} className="relative">
              {bar && (
                <div
                  className="absolute inset-y-0 left-0 rounded-sm opacity-15"
                  style={{ width: `${(bar(item) / max) * 100}%`, background: "var(--series-1)" }}
                />
              )}
              <div className="relative flex items-baseline justify-between gap-3 px-1 py-0.5">
                <span className="muted w-5 shrink-0 text-xs">{i + 1}.</span>
                {render(item, i)}
              </div>
            </li>
          ))}
        </ol>
      )}
      {note && <p className="muted mt-3 text-xs">{note}</p>}
    </div>
  );
}
