import { Link } from "react-router-dom";

/** Tag key as used in URLs and filters (mirrors core's normalizeTagKey). */
function tagKey(label: string): string {
  return label.replace(/^\s*#+/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A Snipd tag. Clicking filters to it; these come from the Snipd app and are
 * read-only here (change them in Snipd and sync).
 */
export default function TagChip({
  label,
  count,
  active,
  onClick,
  size = "text-xs",
}: {
  label: string;
  count?: number;
  active?: boolean;
  onClick?: () => void;
  size?: string;
}) {
  const content = (
    <>
      #{label}
      {count !== undefined && <span className="ml-1 opacity-60">{count.toLocaleString()}</span>}
    </>
  );
  const className = `rounded-full px-2 py-0.5 ${size} whitespace-nowrap transition-opacity hover:opacity-80`;
  const style = active
    ? { background: "var(--series-1)", color: "var(--surface-1)" }
    : { background: "var(--series-1-soft)" };

  if (onClick)
    return (
      <button type="button" onClick={onClick} className={className} style={style} aria-pressed={!!active}>
        {content}
      </button>
    );
  return (
    <Link to={`/tags/${encodeURIComponent(tagKey(label))}`} className={className} style={style} title={`See everything tagged #${label} in Snipd`}>
      {content}
    </Link>
  );
}
