import { useState } from "react";
import { copySnip, type CopyableSnip } from "../copy.ts";

export default function CopyButton({ snip }: { snip: CopyableSnip }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="muted text-xs hover:opacity-70"
      title="Copy as Markdown"
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (await copySnip(snip)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? "✓ copied" : "⧉ copy"}
    </button>
  );
}
