import { parentPort, workerData } from "node:worker_threads";
import { localEmbedder } from "@resurface/core";

/**
 * Embeds search queries — short texts, one at a time — off the HTTP thread.
 * Inference is native CPU work; keeping it out of the main thread means a
 * search never stalls the server, and the main process never loads ONNX.
 */
const { modelDir } = workerData as { modelDir: string };
const embedder = await localEmbedder(modelDir);
parentPort?.postMessage({ type: "ready" });

parentPort?.on("message", async (msg: { id: number; texts: string[] }) => {
  try {
    const vectors = await embedder(msg.texts);
    // Copy out of the model's buffer so the transfer is a plain array.
    parentPort?.postMessage({ id: msg.id, vectors: vectors.map((v) => Array.from(v)) });
  } catch (err) {
    parentPort?.postMessage({ id: msg.id, error: (err as Error).message });
  }
});
