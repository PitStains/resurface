import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_PATH,
  DATA_DIR,
  DB_PATH,
  detectVaults,
  importVault,
  loadConfig,
  openDb,
  renderImportReport,
  saveConfig,
} from "@resurface/core";

function fail(msg: string): never {
  console.error(`\n[resurface] ${msg}`);
  process.exit(1);
}

export function resolveVaultPath(argVault: string | undefined): string {
  const cfg = loadConfig();
  if (argVault) {
    if (!existsSync(argVault)) fail(`--vault path does not exist: ${argVault}`);
    cfg.vaultPath = argVault;
    saveConfig(cfg);
    return argVault;
  }
  if (cfg.vaultPath && existsSync(cfg.vaultPath)) return cfg.vaultPath;

  const { candidates, ignoredBackups } = detectVaults();
  if (ignoredBackups.length > 0) console.log(`Ignoring backup vault(s):\n  ${ignoredBackups.join("\n  ")}`);
  if (candidates.length === 0)
    fail('No Snipd vault found. Pass it explicitly:\n  npm run import -- --vault "C:\\path\\to\\Snipd\\Snipd\\Data"');
  if (candidates.length > 1) console.log(`Multiple vaults found, using the first:\n  ${candidates.join("\n  ")}`);
  cfg.vaultPath = candidates[0];
  saveConfig(cfg);
  return candidates[0];
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Only one process may touch the database. When the app is already running it
 * owns the file, so a sync is handed to it over HTTP rather than opened here —
 * two processes on this file is what corrupted a database once, and refusing is
 * cheaper than recovering.
 */
async function delegateToRunningApp(port: number): Promise<boolean> {
  const base = `http://127.0.0.1:${port}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const alive = await fetch(`${base}/api/meta`, { signal: controller.signal }).finally(() =>
      clearTimeout(timer)
    );
    if (!alive.ok) return false;
  } catch {
    return false; // nothing running: this process may open the database itself
  }
  console.log(`[resurface] Resurface is already running on ${base} — asking it to sync instead.`);
  const res = await fetch(`${base}/api/sync`, { method: "POST" });
  const body = (await res.json()) as { snipsNew?: number; filesParsed?: number; error?: string };
  if (!res.ok) fail(`sync failed: ${body.error ?? res.status}`);
  console.log(
    `[resurface] done — ${body.filesParsed ?? 0} parsed, ${body.snipsNew ?? 0} new snips. ` +
      `Open ${base} to see the results.`
  );
  return true;
}

async function cmdImport(args: string[]) {
  const vault = resolveVaultPath(getFlag(args, "--vault"));
  const dbPath = getFlag(args, "--db") ?? DB_PATH;
  const port = Number(process.env.PORT ?? 7433);
  if (dbPath === DB_PATH && (await delegateToRunningApp(port))) return;

  console.log(`[resurface] vault: ${vault}`);
  console.log(`[resurface] db:    ${dbPath}`);

  const db = openDb(dbPath);
  const t0 = Date.now();
  const report = importVault(db, vault, { force: args.includes("--full") });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(
    `[resurface] done in ${secs}s — ${report.filesParsed} parsed, ${report.filesUnchanged} unchanged, ` +
      `${report.filesSkipped} skipped, ${report.snipsNew} new snips, ${report.warnings.length} warnings`
  );
  console.log(
    `[resurface] library: ${report.totals.shows} shows · ${report.totals.episodes} episodes · ${report.totals.snips} snips`
  );

  const reportsDir = join(DATA_DIR, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const stamp = report.finishedAt.replace(/[:.]/g, "-").slice(0, 19);
  const reportPath = join(reportsDir, `import-${stamp}.html`);
  writeFileSync(reportPath, renderImportReport(report, db));
  console.log(`[resurface] report: ${reportPath}`);
  db.close();

  if (!args.includes("--no-open") && process.platform === "win32") {
    execFile("cmd", ["/c", "start", "", reportPath]);
  }
}

function cmdDoctor() {
  console.log(`node:        ${process.version}`);
  console.log(`data dir:    ${DATA_DIR}${existsSync(DATA_DIR) ? "" : " (will be created)"}`);
  console.log(`db:          ${DB_PATH}${existsSync(DB_PATH) ? "" : " (not created yet)"}`);
  console.log(`config:      ${CONFIG_PATH}`);
  const cfg = loadConfig();
  const { candidates, ignoredBackups } = detectVaults();
  console.log(`config vault: ${cfg.vaultPath ?? "(unset)"}`);
  console.log(`detected:     ${candidates.join(" | ") || "(none)"}`);
  if (ignoredBackups.length) console.log(`backups ignored: ${ignoredBackups.join(" | ")}`);
  try {
    const db = openDb(":memory:");
    db.exec("CREATE TABLE t(x)");
    db.close();
    console.log("sqlite:      OK (node:sqlite)");
  } catch (err) {
    console.log(`sqlite:      FAILED — ${(err as Error).message}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
/** A lock clash is expected operator error, not a crash — say so plainly. */
function run(work: () => unknown) {
  try {
    const result = work();
    if (result instanceof Promise) result.catch((err) => fail(String((err as Error).message ?? err)));
  } catch (err) {
    fail(String((err as Error).message ?? err));
  }
}
switch (cmd) {
  case "import":
    run(() => cmdImport(rest));
    break;
  case "doctor":
    run(() => cmdDoctor());
    break;
  default:
    console.log("Usage: resurface <import|doctor> [--vault <path>] [--db <path>] [--no-open] [--full]");
    process.exit(cmd ? 1 : 0);
}
