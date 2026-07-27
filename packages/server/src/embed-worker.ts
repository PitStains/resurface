import { parentPort, workerData } from "node:worker_threads";
import { embedAll, localEmbedder, openDb } from "@resurface/core";

/**
 * Embedding runs here, off the HTTP thread: ONNX inference is CPU-bound and
 * would otherwise stall every request for the length of the build. The worker
 * opens the same SQLite file (WAL handles the concurrent writer) and reports
 * progress back; the main process only reads counts.
 *
 * migrate: false is load-bearing — the main process owns the schema. A worker
 * running DDL alongside it corrupted the database once.
 */
const { dbPath, modelDir, threads, pauseMs } = workerData as {
  dbPath: string;
  modelDir: string;
  threads: number;
  pauseMs: number;
};
const db = openDb(dbPath, { migrate: false });
const signal = { aborted: false };

parentPort?.on("message", (msg) => {
  if (msg === "stop") signal.aborted = true;
});

try {
  const embedder = await localEmbedder(modelDir, { threads });
  parentPort?.postMessage({ type: "ready" });
  const { embedded } = await embedAll(db, embedder, {
    signal,
    batchSize: 32,
    pauseMs,
    onProgress: (done, total) => parentPort?.postMessage({ type: "progress", done, total }),
  });
  parentPort?.postMessage({ type: "done", embedded, aborted: signal.aborted });
} catch (err) {
  parentPort?.postMessage({ type: "error", message: (err as Error).message });
} finally {
  db.close();
  // The message listener keeps this worker's event loop alive, so the thread
  // has to close its own port — otherwise a finished build never reports done.
  parentPort?.close();
}
