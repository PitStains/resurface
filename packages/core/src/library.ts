import type { DatabaseSync } from "node:sqlite";

export function listShows(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT s.id, s.title, s.author, s.image_url AS imageUrl, s.url,
              COUNT(DISTINCT e.id) AS episodes, COUNT(sn.id) AS snips,
              MAX(e.last_snip_date) AS lastActivity
       FROM shows s
       JOIN episodes e ON e.show_id = s.id
       JOIN snips sn ON sn.episode_id = e.id
       GROUP BY s.id
       ORDER BY lastActivity DESC`
    )
    .all();
}

export function getShow(db: DatabaseSync, id: string) {
  const show = db
    .prepare("SELECT id, title, author, image_url AS imageUrl, url FROM shows WHERE id = ?")
    .get(id);
  if (!show) return null;
  const episodes = db
    .prepare(
      `SELECT e.id, e.title, e.publish_date AS publishDate, e.last_snip_date AS lastSnipDate,
              e.duration_sec AS durationSec, e.ai_description AS aiDescription,
              e.archived AS missingFromVault,
              COUNT(s.id) AS snips
       FROM episodes e
       LEFT JOIN snips s ON s.episode_id = e.id
       WHERE e.show_id = ?
       GROUP BY e.id
       ORDER BY e.last_snip_date DESC, e.publish_date DESC`
    )
    .all(id);
  return { ...show, episodes };
}

export function getEpisode(db: DatabaseSync, id: string) {
  const episode = db
    .prepare(
      `SELECT e.id, e.title, e.publish_date AS publishDate, e.last_snip_date AS lastSnipDate,
              e.duration_sec AS durationSec, e.ai_description AS aiDescription, e.url,
              e.image_url AS imageUrl, s.id AS showId, s.title AS showTitle
       FROM episodes e JOIN shows s ON s.id = e.show_id
       WHERE e.id = ?`
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!episode) return null;
  const snips = db
    .prepare(
      `SELECT id, ord, title, share_url AS shareUrl, start_sec AS startSec, end_sec AS endSec,
              duration_sec AS durationSec, summary_md AS summaryMd, quote_text AS quoteText,
              quote_attribution AS quoteAttribution, quote_caption AS quoteCaption,
              transcript_md AS transcriptMd, favorited, tags_json AS tagsJson,
              archived AS missingFromVault
       FROM snips WHERE episode_id = ? ORDER BY ord`
    )
    .all(id);
  const guests = db
    .prepare(
      `SELECT g.name, g.url FROM guests g JOIN episode_guests eg ON eg.guest_id = g.id WHERE eg.episode_id = ?`
    )
    .all(id);
  const books = db
    .prepare(
      `SELECT b.title, b.author, b.url FROM books b JOIN episode_books eb ON eb.book_id = b.id WHERE eb.episode_id = ?`
    )
    .all(id);
  return { ...episode, snips, guests, books };
}

/** Most recently active episodes — the dashboard's "recently added" feed. */
export function getRecent(db: DatabaseSync, limit = 12) {
  return db
    .prepare(
      `SELECT e.id, e.title, e.last_snip_date AS lastSnipDate, s.title AS showTitle,
              COUNT(sn.id) AS snips
       FROM episodes e
       JOIN shows s ON s.id = e.show_id
       JOIN snips sn ON sn.episode_id = e.id
       WHERE e.last_snip_date IS NOT NULL
       GROUP BY e.id
       ORDER BY e.last_snip_date DESC, e.export_date DESC
       LIMIT ?`
    )
    .all(limit);
}
