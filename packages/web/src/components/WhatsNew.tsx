import type { ChangelogEntry } from "../api.ts";

export default function WhatsNew({
  version,
  entries,
  onClose,
}: {
  version: string;
  entries: ChangelogEntry[];
  onClose: () => void;
}) {
  const current = entries.find((e) => e.version === version) ?? entries[0];
  if (!current) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
    >
      <div className="card max-h-[80vh] w-full max-w-lg overflow-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-xs muted">What's new</div>
        <h2 className="mb-3 text-lg font-semibold">
          Resurface v{current.version} <span className="ink-2 text-sm font-normal">· {current.date}</span>
        </h2>
        <ul className="mb-4 list-disc space-y-1 pl-5 text-sm">
          {current.changes.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
        {current.whatToTest.length > 0 && (
          <>
            <h3 className="mb-2 text-sm font-semibold">What to test</h3>
            <ul className="mb-4 list-disc space-y-1 pl-5 text-sm ink-2">
              {current.whatToTest.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </>
        )}
        <button className="card px-4 py-2 text-sm font-medium hover:opacity-80" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  );
}
