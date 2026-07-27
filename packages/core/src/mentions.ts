import type { DatabaseSync } from "node:sqlite";

/** Books mentioned across all snipped episodes, most-mentioned first (plan 4.11). */
export function listBooks(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT b.id, b.title, b.author, b.url,
              COUNT(DISTINCT eb.episode_id) AS mentions,
              COUNT(DISTINCT e.show_id) AS shows,
              MAX(e.last_snip_date) AS lastMention
       FROM books b
       JOIN episode_books eb ON eb.book_id = b.id
       JOIN episodes e ON e.id = eb.episode_id
       GROUP BY b.id
       ORDER BY mentions DESC, lastMention DESC`
    )
    .all();
}

export function bookEpisodes(db: DatabaseSync, bookId: string) {
  return db
    .prepare(
      `SELECT e.id, e.title, e.last_snip_date AS lastSnipDate, sh.title AS showTitle
       FROM episode_books eb
       JOIN episodes e ON e.id = eb.episode_id
       JOIN shows sh ON sh.id = e.show_id
       WHERE eb.book_id = ?
       ORDER BY e.last_snip_date DESC`
    )
    .all(bookId);
}

/** Guests across all shows, most-featured first. */
export function listPeople(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT g.id, g.name, g.url,
              COUNT(DISTINCT eg.episode_id) AS episodes,
              COUNT(DISTINCT e.show_id) AS shows,
              MAX(e.last_snip_date) AS lastSeen
       FROM guests g
       JOIN episode_guests eg ON eg.guest_id = g.id
       JOIN episodes e ON e.id = eg.episode_id
       GROUP BY g.id
       ORDER BY episodes DESC, lastSeen DESC`
    )
    .all();
}

export function personEpisodes(db: DatabaseSync, personId: string) {
  return db
    .prepare(
      `SELECT e.id, e.title, e.last_snip_date AS lastSnipDate, sh.title AS showTitle
       FROM episode_guests eg
       JOIN episodes e ON e.id = eg.episode_id
       JOIN shows sh ON sh.id = e.show_id
       WHERE eg.guest_id = ?
       ORDER BY e.last_snip_date DESC`
    )
    .all(personId);
}
