/** Minimal safe renderer for the markdown subset in Snipd exports (bullets, bold). */
export default function Md({ text, className }: { text: string; className?: string }) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  return (
    <div className={className}>
      {lines.map((line, i) => {
        const heading = line.match(/^#{3,4}\s+(.*)$/);
        if (heading) {
          return (
            <div key={i} className="mb-1 mt-3 text-sm font-semibold">
              {heading[1]}
            </div>
          );
        }
        const isBullet = /^\s*[-*]\s+/.test(line);
        const content = line.replace(/^\s*[-*]\s+/, "");
        const parts = content.split(/\*\*([^*]+)\*\*/g);
        const rendered = parts.map((p, j) => (j % 2 === 1 ? <strong key={j}>{p}</strong> : p));
        return isBullet ? (
          <div key={i} className="flex gap-2">
            <span className="muted">•</span>
            <span>{rendered}</span>
          </div>
        ) : (
          <p key={i} className="mb-2">
            {rendered}
          </p>
        );
      })}
    </div>
  );
}
