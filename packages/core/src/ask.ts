import type { DatabaseSync } from "node:sqlite";
import type { Embedder } from "./embeddings.ts";
import { hybridSearch } from "./related.ts";
import type { SearchHit } from "./search.ts";

/**
 * Ask (Phase 4): answer a question from your own snips, always with citations.
 *
 * Two modes, and the honest one is the default: **extractive** stitches the
 * best passages together and cites each one, inventing nothing. If a local LLM
 * is configured (Ollama), it writes a short narrative over those same passages
 * and is required to cite; when it's unreachable or slow, the extractive answer
 * still stands. Nothing is ever sent to a paid or remote service.
 */
export interface AskSource extends SearchHit {
  n: number; // citation number, [1]-based
  passage: string;
}

export interface AskAnswer {
  question: string;
  answer: string;
  mode: "extractive" | "llm";
  sources: AskSource[];
  llmError: string | null;
  tookMs: number;
}

export interface LlmConfig {
  provider: "ollama";
  url?: string; // default http://127.0.0.1:11434
  model?: string; // default llama3.2
}

/** The most quotable part of a snip: its own words, not its metadata. */
function passageOf(hit: SearchHit): string {
  const summary = (hit.summaryMd ?? "")
    .replace(/^[\s>]*[-*+]\s+/gm, " ")
    .replace(/[*_`>#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const quote = hit.quoteText?.trim();
  const text = quote && quote.length > 40 ? quote : summary || quote || hit.title || "";
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

function extractiveAnswer(question: string, sources: AskSource[]): string {
  if (sources.length === 0)
    return `Nothing in your library answers “${question}” yet. Try different words, or check that the meaning index is built.`;
  const lines = [
    `Your snips say this about “${question}” — quoted directly, nothing generated:`,
    "",
    ...sources.slice(0, 5).map((s) => `[${s.n}] ${s.passage}`),
  ];
  return lines.join("\n");
}

export interface LlmProbe {
  ok: boolean;
  /** Reachable server, whatever the model situation. */
  reachable: boolean;
  models: string[];
  /** What the user should do next, in plain language. Empty when ok. */
  problem: string;
  fix: string;
  url: string;
}

const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";

/**
 * Ask the local Ollama whether it is actually there, before anything is saved.
 * Connecting used to write the setting unconditionally, so a machine without
 * Ollama installed looked connected and then failed on every question with
 * "fetch failed" and no way back.
 */
export async function probeOllama(cfg: Partial<LlmConfig> = {}, timeoutMs = 5_000): Promise<LlmProbe> {
  const url = (cfg.url ?? OLLAMA_DEFAULT_URL).replace(/\/$/, "");
  const wanted = cfg.model ?? "llama3.2";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/tags`, { signal: controller.signal });
    if (!res.ok) throw new Error(`responded ${res.status}`);
    const body = (await res.json()) as { models?: { name: string }[] };
    const models = (body.models ?? []).map((m) => m.name);
    if (models.length === 0)
      return {
        ok: false, reachable: true, models, url,
        problem: "Ollama is running but has no models downloaded.",
        fix: `Run  ollama pull ${wanted}  in a terminal, then connect again.`,
      };
    // Ollama names models "llama3.2:latest"; accept the bare name too.
    const match = models.find((m) => m === wanted || m.split(":")[0] === wanted.split(":")[0]);
    if (!match)
      return {
        ok: false, reachable: true, models, url,
        problem: `Ollama is running, but “${wanted}” isn't one of its models.`,
        fix: `Either pick one of: ${models.join(", ")} — or run  ollama pull ${wanted}`,
      };
    return { ok: true, reachable: true, models, url, problem: "", fix: "" };
  } catch (err) {
    const aborted = (err as Error).name === "AbortError";
    return {
      ok: false, reachable: false, models: [], url,
      problem: aborted
        ? `Nothing answered at ${url} within ${timeoutMs / 1000}s.`
        : `Nothing is listening at ${url}.`,
      fix:
        "Ollama is a separate free program — Resurface can't install it for you. " +
        "Download it from ollama.com, install it, then run  ollama pull llama3.2  in a terminal. " +
        "Leave Ollama running and connect again.",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function askOllama(
  question: string,
  sources: AskSource[],
  cfg: LlmConfig,
  timeoutMs = 60_000
): Promise<string> {
  const url = `${(cfg.url ?? "http://127.0.0.1:11434").replace(/\/$/, "")}/api/generate`;
  const context = sources
    .map((s) => `[${s.n}] (${s.showTitle} — ${s.episodeTitle}) ${s.passage}`)
    .join("\n\n");
  const prompt = [
    "You answer strictly from the numbered excerpts of the user's own podcast notes.",
    "Cite every claim with its bracket number, e.g. [2]. Never state anything not present in the excerpts.",
    "If the excerpts don't answer the question, say so plainly.",
    "Answer in at most 150 words.",
    "",
    `Question: ${question}`,
    "",
    "Excerpts:",
    context,
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model ?? "llama3.2", prompt, stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const body = (await res.json()) as { response?: string };
    const text = (body.response ?? "").trim();
    if (!text) throw new Error("Ollama returned an empty response");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retrieve, then answer. Retrieval is the hybrid search already in use, so a
 * question works whether or not it shares wording with the snips.
 */
export async function ask(
  db: DatabaseSync,
  question: string,
  embedder: Embedder,
  opts: { llm?: LlmConfig | null; k?: number; show?: string } = {}
): Promise<AskAnswer> {
  const t0 = performance.now();
  const k = opts.k ?? 8;
  const q = question.trim();
  if (!q)
    return { question, answer: "Ask a question about anything you've snipped.", mode: "extractive", sources: [], llmError: null, tookMs: 0 };

  const result = await hybridSearch(db, q, embedder, { limit: k, show: opts.show });
  const sources: AskSource[] = result.hits.map((h, i) => ({ ...h, n: i + 1, passage: passageOf(h) }));

  let answer = extractiveAnswer(q, sources);
  let mode: AskAnswer["mode"] = "extractive";
  let llmError: string | null = null;
  if (opts.llm && sources.length > 0) {
    try {
      answer = await askOllama(q, sources, opts.llm);
      mode = "llm";
    } catch (err) {
      // Fail soft: the cited passages are still a real answer.
      llmError = (err as Error).message;
    }
  }
  return { question: q, answer, mode, sources, llmError, tookMs: Math.round((performance.now() - t0) * 10) / 10 };
}
