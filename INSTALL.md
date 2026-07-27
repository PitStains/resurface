# Installing, running, and keeping Resurface alive

Everything here is local. Nothing is published, nothing phones home, and no account is involved.

## Requirements

- **Node.js 22 or newer** (developed on 25). `node --version` to check.
- **Windows, macOS or Linux.** The `.bat` shortcuts are Windows; elsewhere use the npm scripts.
- About **1.5 GB** free: the database grows with your library, and backups keep three snapshots by default.

## First run

1. Clone or download the repository.
2. Double-click **`Start Resurface.bat`** (Windows), or run:

```bash
npm ci && npm run build:web && npm run serve
```

The app opens at <http://127.0.0.1:7433>. On first start it looks for your Snipd export — the folder your
Obsidian plugin writes to, usually `…\Obsidian Vault\Snipd\Snipd\Data`. If it finds exactly one, it adopts
it; otherwise it asks. Your vault is only ever **read**.

Then, on the dashboard, press **Build index** under *Meaning index*. It downloads a ~25 MB model once and
embeds your snips locally — roughly 45 minutes for 30,000 snips on the default "Gentle" setting, which
deliberately leaves your machine usable. Search, Ask, Topics, Map and Review all need it.

You only press it once. From then on, snips brought in by a sync are embedded automatically, and the app
catches up on anything that arrived while it was closed.

## Updating

Double-click **`Update Resurface.bat`**, or:

```bash
git pull && npm ci && npm run build:web && npm run serve
```

`npm ci` matters: plain `npm install` has been observed leaving the embedding library half-installed, which
makes the meaning index look empty and rebuild itself from scratch.

## Starting automatically at login (Windows)

Resurface is a local server, so it has to be running for the app to open. To start it with Windows:

1. Press `Win + R`, type `shell:startup`, press Enter. A folder opens.
2. Right-click `Start Resurface.bat` → **Copy**, then right-click inside the startup folder →
   **Paste shortcut**.
3. To start it quietly, right-click the shortcut → **Properties** → **Run: Minimized**.

To stop it starting automatically, delete the shortcut from that folder. This runs it as you, at login —
no service, no admin rights, no scheduled task.

If you'd rather not autostart, just double-click `Start Resurface.bat` when you want it.

## Where your data lives

| What | Where |
|---|---|
| Database | `%LOCALAPPDATA%\Resurface\resurface.db` |
| Backups | `%LOCALAPPDATA%\Resurface\backups\` |
| Settings | `%LOCALAPPDATA%\Resurface\config.json` |
| Model cache | `%LOCALAPPDATA%\Resurface\models\` |
| Import reports | `%LOCALAPPDATA%\Resurface\reports\` |
| Server log | `%LOCALAPPDATA%\Resurface\logs\server.log` (previous run: `server-previous.log`) |
| NotebookLM packs | `%LOCALAPPDATA%\Resurface\exports\notebooklm-<timestamp>\` (one folder per export; delete freely) |

None of this is in the repository, and none of it leaves your machine.

## Settings worth knowing

`config.json` accepts:

| Key | Default | What it does |
|---|---|---|
| `backupKeep` | `3` | Full snapshots kept (~320 MB each) |
| `backupEveryHours` | `24` | How often a snapshot is taken |
| `reviewSize` | `5` | Cards in the daily review |
| `reviewManualQuota` | `3` | How many of those are snips you made by hand |
| `embedSpeed` | `gentle` | `gentle`, `balanced` or `fast` |

## If something goes wrong

**"Resurface is already running (process N)."** Only one copy may open the database. Close the other window,
or end that process. This is deliberate — two processes writing one SQLite file is how databases get damaged.

**Every page went blank, and a red bar says Resurface isn't responding.** The app is running but the server
stopped answering. The usual cause is the console window it started in: **clicking inside a Windows console
puts it into "Select" mode** — the title bar changes to `Select …` — and that freezes whatever process owns
the window the next time it prints anything. Press **Esc** in that window and everything resumes, nothing is
lost. Since v0.12.2 the `.bat` files send the server's output to a log file instead, so a stray click can no
longer reach it; if you start the server by hand with `npm run serve`, the old exposure is still there.

**The dashboard warns that the database has a problem.** Open *Backups* and restore the most recent
snapshot; it is verified before it is offered. The database being replaced is moved aside, never deleted, and
your Snipd vault is untouched regardless.

**The meaning index says 0 after an update.** The embedding library probably didn't install. Run
`npm ci`, confirm `node_modules/@huggingface/transformers` exists, and restart. Recent versions of both
`.bat` files check this for you.

**Antivirus and this database.** Real-time scanners inspect files as they are written, and a few hundred
megabytes of SQLite under heavy write load is exactly the shape of thing that trips them up. If you see
repeated database problems, consider excluding `%LOCALAPPDATA%\Resurface\` in Windows Security →
Virus & threat protection → Manage settings → Exclusions. That is a change to your machine's security
posture, so make it deliberately — and only for this folder.
