import { parentPort, workerData } from "node:worker_threads";
import { buildTopics, openDb } from "@resurface/core";

/**
 * Clustering and the map projection are CPU-bound loops over 32k × 384 floats,
 * so they run here rather than on the HTTP thread — same reasoning as the
 * embedding worker. The main process owns the schema; see embed-worker.
 */
const { dbPath, k } = workerData as { dbPath: string; k?: number };
const db = openDb(dbPath, { migrate: false });

try {
  const result = buildTopics(db, {
    k,
    onProgress: (phase, done, total) => parentPort?.postMessage({ type: "progress", phase, done, total }),
  });
  parentPort?.postMessage({ type: "done", ...result });
} catch (err) {
  parentPort?.postMessage({ type: "error", message: (err as Error).message });
} finally {
  db.close();
  parentPort?.close();
}
