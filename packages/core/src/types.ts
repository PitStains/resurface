/** A snip parsed from an episode Markdown file. */
export interface ParsedSnip {
  id: string;
  title: string;
  shareUrl: string | null;
  startSec: number | null;
  endSec: number | null;
  durationSec: number | null;
  summaryMd: string | null;
  quoteText: string | null;
  quoteAttribution: string | null;
  quoteCaption: string | null;
  transcriptMd: string | null;
  /** Present only if the user customized the Snipd snip template to include a Created: line. */
  createdDate: string | null;
  /** True when the snip is favorited in the Snipd app (⭐ in the exported heading). */
  favorited: boolean;
  /** Tags rendered into the heading by the Snipd template ([[tag]] or #tag). */
  tags: string[];
  ord: number;
}

export interface ParsedPerson {
  id: string;
  name: string;
  url: string | null;
}

export interface ParsedBook {
  id: string;
  title: string;
  author: string | null;
  url: string | null;
}

/** An episode file parsed from the Snipd vault. */
export interface ParsedEpisode {
  id: string;
  showId: string;
  showTitle: string;
  showAuthor: string | null;
  showUrl: string | null;
  showImageUrl: string | null;
  title: string;
  publishDate: string | null; // YYYY-MM-DD
  lastSnipDate: string | null; // YYYY-MM-DD
  durationSec: number | null;
  exportDate: string | null;
  aiDescription: string | null;
  url: string | null;
  imageUrl: string | null;
  guests: ParsedPerson[];
  books: ParsedBook[];
  snips: ParsedSnip[];
  warnings: string[];
}

export interface ImportFileResult {
  file: string;
  status: "parsed" | "unchanged" | "skipped";
  warnings: string[];
}

export interface ImportReport {
  startedAt: string;
  finishedAt: string;
  vaultPath: string;
  filesSeen: number;
  filesParsed: number;
  filesUnchanged: number;
  filesSkipped: number;
  snipsNew: number;
  snipsUpdated: number;
  snipsArchived: number;
  episodesArchived: number;
  warnings: { file: string; message: string }[];
  totals: { shows: number; episodes: number; snips: number };
}
