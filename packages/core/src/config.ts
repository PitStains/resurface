import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR =
  process.env.RESURFACE_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? homedir(), "Resurface");
export const CONFIG_PATH = join(DATA_DIR, "config.json");
export const DB_PATH = join(DATA_DIR, "resurface.db");

export interface Config {
  vaultPath?: string;
  /** How much CPU the meaning-index build may take (§4.6). */
  embedSpeed?: EmbedSpeed;
  /** Optional local LLM for Ask; unset means the extractive answer (§4.4). */
  llm?: { provider: "ollama"; url?: string; model?: string } | null;
  /** Cosine cutoff for automatic category assignment (§4.7). */
  categoryThreshold?: number;
  /** Daily review: how many cards, and how many of them hand-made. */
  reviewSize?: number;
  reviewManualQuota?: number;
  /** Backups: how many full snapshots to keep, and how often to take one. */
  backupKeep?: number;
  backupEveryHours?: number;
}

export type EmbedSpeed = "gentle" | "balanced" | "fast";

/**
 * Embedding is CPU-bound, and by default ONNX grabs every core — enough to make
 * the whole machine sluggish. These profiles cap threads and idle between
 * batches so the build can run while you keep working.
 */
export const EMBED_SPEEDS: Record<EmbedSpeed, { threads: number; pauseMs: number; label: string }> = {
  gentle: { threads: 1, pauseMs: 400, label: "Gentle · one core, stays out of your way" },
  balanced: { threads: 2, pauseMs: 100, label: "Balanced · two cores" },
  fast: { threads: 0, pauseMs: 0, label: "Fast · all cores, expect a busy machine" },
};

export function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveConfig(cfg: Config): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/** Find likely Snipd Data folders; prefer the live Obsidian vault, skip backups. */
export function detectVaults(): { candidates: string[]; ignoredBackups: string[] } {
  const home = homedir();
  // Where an Obsidian vault normally lives. "Obsidian Vault" is the default
  // folder the app suggests, so it is worth looking inside it by name.
  const roots = [
    join(home, "Documents", "Obsidian Vault"),
    join(home, "Documents"),
    join(home, "Desktop", "Obsidian Vault"),
    join(home, "Desktop"),
    join(home, "Obsidian Vault"),
  ];
  const candidates: string[] = [];
  const ignoredBackups: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/^snipd/i.test(name)) continue;
      const dataDir = join(root, name, "Snipd", "Data");
      if (!existsSync(dataDir)) continue;
      if (/backup/i.test(name)) ignoredBackups.push(dataDir);
      else if (!candidates.includes(dataDir)) candidates.push(dataDir);
    }
  }
  return { candidates, ignoredBackups };
}
