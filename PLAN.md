# Resurface — a second brain for your Snipd podcast notes

**Product & engineering plan · v3 · 2026-07-20**
*Working title "Resurface" — rename freely. This document is self-contained and intended to be handed to a developer as-is.*

---

## 0. Executive summary

The owner has ~6 months of heavy Snipd usage synced to an Obsidian vault as Markdown:
**4,129 episode files · 162 shows · 31,951 snips · ~1,556 hours of snipped episode audio** (measured 2026-07-20 from `Snipd\Snipd\Data\`). Each file carries YAML frontmatter (durations, dates, guests, mentioned books, share URLs) and per-snip AI summaries, quotes, and full transcripts.

No existing free tool combines listening statistics, semantic search/Q&A, similarity mapping, auto-categorization, favorites-weighted ranking, and active resurfacing over this data. Readwise is subscription-only; Obsidian plugins cover fragments; NotebookLM caps a notebook at 50 sources free / 300 on Pro / 600 on Ultra and has no API for personal accounts, so it can receive an export (§4.10) but cannot be the system of record.

**Resurface** is a local-first web app (TypeScript, SQLite, local embeddings, optional local/free-tier LLM) that ingests the vault read-only, and provides:

1. **Stats** — playtime per show, week/month/year/all-time, comparisons, streaks, yearly "Wrapped".
2. **Search & Ask** — keyword + semantic hybrid search; question-answering with citations back to snips and into the Snipd app.
3. **Themes & Map** — clustering, labeled topics, 2-D similarity map, "related snips" everywhere.
4. **Auto-categorization** — cluster-seeded, user-editable taxonomy applied to all snips/episodes.
5. **Favorites** — star shows/episodes/snips; chronological favorites timeline; favorites boosted in every ranking and analysis.
6. **Resurfacing** — daily review with spaced repetition, "on this day", weekly digest, serendipity — the "I listened to it all but forgot it" engine.

Everything runs free: local machine first; optional phone access via Tailscale (free personal plan) or an optional Cloudflare free-tier deployment (designed below to actually fit the free limits, which naïve designs do not).

---

## 1. Why build: the existing-tool landscape

| Tool | What it covers | Why it's not enough | Cost |
|---|---|---|---|
| **Snipd app itself** | Capture, AI summaries/transcripts, export | No corpus-wide stats dashboards, no cross-episode search/Q&A/clustering over your history | Freemium |
| **Readwise / Reader** | Highlight aggregation, daily review, Snipd integration | No listening stats, no clustering/map, no favorites-weighted analytics; **no permanent free plan** (30-day trial, then ~$5.59+/mo) | Paid |
| **Obsidian + Bases** (already installed) | Browsing, manual queries/tables | No semantic layer, no stats aggregation, no resurfacing engine | Free |
| **Obsidian Smart Connections** | Local-embedding related notes, semantic search | Note-level only, no podcast semantics (durations, time ranges), no stats/favorites/review | Free core |
| **Khoj / Reor / AnythingLLM** | Self-hosted RAG chat over Markdown | Generic document chat; no podcast stats, favorites, timelines, categorization UI | Free/OSS |
| **NotebookLM** | Q&A over uploaded sources | 50 sources/notebook (free), manual uploads, no stats, no sync, no favorites | Free w/ caps |
| **GitHub one-off scripts** (`snipd-podcast-format-for-obsidian`, `snipd-podcast-export-processor`) | Re-splitting/re-formatting exports | Parsers only — no product on top | OSS |

**Conclusion:** the parsing problem is solved in fragments, the "second brain over podcast listening" product does not exist. Building is justified. *(Interim setup while building: see Appendix D.)*

---

## 2. Ground truth: the data

### 2.1 What the vault looks like (verified against the real export)

```
<vault>/Snipd/
  README.md                  ← plugin usage guide
  metadata.json              ← plugin state ({"defaultOpenPath": "Base/Snipd.base"})
  Base/Snipd.base            ← Obsidian Bases view (ignore)
  Snipd/Data/{Show}/{Episode}.md   ← one file per episode  ← OUR INPUT
```

Episode file anatomy (fields marked *opt* are sometimes absent):

```yaml
---
episode_title: …
show_title: …
show_author: …
guests: [ … ]                    # opt
mentioned_books: [ … ]           # opt
episode_publish_date: 2026-01-26
last_snip_date: 2026-01-28       # date of the most recent snip in this episode
episode_duration_minutes: 71
episode_url: https://share.snipd.com/episode/<uuid>
show_url: https://share.snipd.com/show/<uuid>
image_url / show_image_url: …
episode_export_date: 2026-01-30T14:25:29
snips_count: 5                   # can go stale in append mode — body is truth
from_snipd: true
---
# {title}
## Episode metadata      ← duplicates frontmatter + "Episode AI description" + guest/book share links
## Snips
###  [Snip title](https://share.snipd.com/snip/<uuid>)      ← stable snip ID
🎧 03:12 - 05:18 (02:05)                                     ← start – end (length)
<iframe src="https://share.snipd.com/embed/obsidian-player/snip/<other-uuid>" …>
- AI summary bullet(s)
#### 💬 Quote            ← opt: blockquote + "— Speaker" + caption line
#### 📚 Transcript       ← opt: speaker-labelled or plain transcript
---                       ← snip separator
```

### 2.2 Corpus measurements (2026-07-20)

| Metric | Value |
|---|---|
| Episode files | 4,129 |
| Shows | 162 (incl. "Your uploads" private audio and article-feed "shows") |
| Total snips | 31,951 |
| Episode durations | avg 22.6 min · max 178 min · **sum ≈ 1,556 h** |
| Snip activity span | 2026-01-26 → 2026-07-20 (≈ 500–800 episodes snipped/month) |
| Episode publish dates | 2017 → 2026 |

Design consequences: SQLite handles this trivially; 32k embeddings at 384-d ≈ 49 MB — local CPU is fine; the corpus is skewed (hundreds of very short daily episodes next to 3-hour interviews), so every "top shows" stat needs **hours**, **snip-count**, and **snips/hour** lenses.

### 2.3 What the export does NOT contain — honesty rules

These were verified absent by scanning all 4,129 files. The product must be truthful about them:

| Missing | Consequence | Rule |
|---|---|---|
| **Listening history** (what you actually played, when) | True "time listened" is unknowable from the export | Report two labeled bounds: **Confirmed** = union of snip time-ranges; **Estimated** = full episode duration for every episode with ≥ 1 snip. Never present either as exact. |
| **Per-snip creation timestamps** | Time-series bucket = episode `last_snip_date` (date-only, local time) | Label period stats "by snip date (per episode)". Enrichment path: the Snipd plugin's Custom Formatting templates may expose a per-snip created-date variable — if so, instruct users to add it (e.g. `> Created: {{date}}` line); parser already accepts an optional `Created:` line per snip (§9.1). |
| ~~**Favorites / stars**~~ **— corrected 2026-07-20: they DO export** | The default plugin snip template starts with `{{snip_favorite_star}}`, so a Snipd-app favorite renders as `### ⭐ [Title](url)` | Parser imports them into `snips.favorited` (546 found in the real vault): read-only **Favorites** on the Starred page, boosting search. In-app stars are a separate concept, **Bookmarks** (§4.5). |
| ~~**Manual notes & tags**~~ **— tags DO export** (`{{snip_tags}}` → `[[tag]]` wiki-links in the heading); notes do not (`{{snip_note}}` is available but unused by the default template) | 1,172 tagged snips today, 6 distinct tags | Snipd tags become first-class in Phase 2.5 (§4.12). Personal notes and **Labels** live only in Resurface's DB, never written into the vault (§4.9). |
| Time-of-day data | No listening-clock charts | Calendar heatmap by day is the finest granularity. |

### 2.4 Sync behavior that shapes the parser (from the plugin README)

- If the user **hasn't edited** an episode file, sync **replaces the whole file** (snips deleted in the app disappear).
- If the user **has edited** it, new snips are **appended** and some frontmatter (`snips_count`) is updated — so files can contain user text between snip blocks, and frontmatter counts can disagree with the body. **Body is the source of truth.**
- Deleting README/Base regenerates them. A vault often sits next to dated backup copies of itself (`Snipd backup <date>`), which look identical to the parser → Resurface points at exactly **one** canonical `Data` folder and warns when sibling folders look like other Snipd vaults.

---

## 3. Product definition: personas, scenarios, and the feature matrix

| # | Persona | Scenario | Features that serve it | Phase |
|---|---|---|---|---|
| P1 | **Power listener (the owner)** | "I've listened to 1,500+ hours and forgotten most of it — help me recall and use it" | Everything; especially Ask, resurfacing, favorites timeline | 1–5 |
| P2 | **Student / researcher** | Build a topic dossier ("everything my podcasts said about one theme") with quotable citations | Hybrid search, collections, export with timestamps + share links | 2–4 |
| P3 | **Writer / creator / speaker** | Mine quotes and stories for an article or talk | Quotes view, exact-copy with attribution, collections, related-snips | 2–4 |
| P4 | **Trend tracker** | "What are my shows saying about AI this quarter?" — watch a topic over time | Saved searches with new-match badges, category trends chart, compare-by-show | 4–5 |
| P5 | **Habit listener** | Daily rhythm: review a few snips each morning, keep streaks | Daily review, "on this day", streaks, calendar heatmap | 5 |
| P6 | **Quantified-self fan** | "My year in podcasts" | Dashboard, comparisons, Wrapped recap with local PNG share-card | 1, 5 |
| P7 | **Privacy-first user** | Nothing leaves the machine | Local-only mode is the default; embeds lazy-loaded; zero telemetry | 1+ |
| P8 | **Multi-source PKM person** | Kindle/Readwise-CSV/YouTube notes beside podcasts | `source` abstraction in schema; importer plugins | 8 |
| P9 | **Phone-centric listener** | Star and review from the phone right after hearing something | Responsive PWA UI + Tailscale or Cloudflare variant | 7 |

Every feature below cites the personas it exists for. Anything serving no persona was cut.

---

## 4. Feature specification

### 4.1 Ingestion & library (P1–P9)

- Config points at one canonical `…\Snipd\Snipd\Data` folder. First-run wizard: pick folder → validate (looks like Snipd export? sibling backups detected? → warn) → import → embedding job starts in background.
- Initial import target: 4k files parsed in **< 2 min** (excluding embeddings). File watcher (chokidar, 2 s debounce, retry on Windows file locks) keeps it live; manual "Sync now" too.
- **Upsert by stable UUIDs** (snip/episode/show share-URL UUIDs). Re-import is idempotent. Content hash per file skips unchanged files.
- **Deletions**: snip present in DB but gone from a rewritten file → **soft-archive** (hidden from views, user data like stars/notes retained, restorable). Never hard-delete user data because upstream changed.
- **Import report** after every run: files parsed / skipped (with reasons) / new / updated / archived snips; parser warnings. Surface in UI; keep last 20 runs.
- Library views: Shows → Episodes → Snips; episode page shows all snips with time ranges, quote, summary, expandable transcript, **deep link into Snipd** (share URL) at the snip; snip page shows provenance + related snips.
- The vault is **read-only** to Resurface. All derived/user data lives in Resurface's own SQLite file.

### 4.2 Statistics & dashboard (P1, P4, P5, P6)

- **Headline tiles**: episodes snipped, snips, shows, confirmed hours (union of snip ranges), estimated hours (episodes-with-snips durations), current/best streak (consecutive days with snip activity; days are credited by episode `last_snip_date`, so an episode snipped across several days credits only the last day — documented limitation).
- **Period views**: past week / month / year / all-time / custom range, bucketed by episode `last_snip_date`; period-over-period comparison ("June: 768 episodes, +2% vs May").
- **Per-show table** (sortable): hours (both bounds), episodes, snips, snips/hour density, first/last activity, favorite share. Three ranking lenses (hours / count / density) because of the short-form-vs-long-form skew.
- **Charts**: activity over time (stacked by show or category), calendar heatmap (GitHub-style), publish-date vs snip-date scatter ("I'm listening to 2019 back-catalog"), category trend lines.
- **Recently added** feed on the dashboard (latest synced snips) — doubles as a quick pulse-check that sync works after each update.
- **Wrapped**: yearly recap page (top shows, top categories, biggest month, longest episode snipped, favorite quotes) rendered to a shareable PNG **locally via canvas** — no external service.
- All stats labeled per the honesty rules (§2.3).

### 4.3 Search (P1–P4)

- **Keyword**: SQLite FTS5, BM25, field-weighted (snip title 4× > quote 2× > summary 2× > transcript 1×); episode titles and AI descriptions indexed too. Target < 100 ms.
- **Semantic**: sqlite-vec KNN over snip embeddings. Target < 300 ms.
- **Hybrid (default)**: Reciprocal Rank Fusion across both lists:
  `score(d) = Σ_lists 1/(60 + rank_list(d))`, then multiply by **favorite boost**: ×1.5 favorited snip, ×1.25 snip in favorited episode, ×1.1 snip in favorited show (configurable in Settings; boosts multiply but cap at ×2). This is the concrete "prioritize favorites in results" mechanism — same boost is reused by Ask retrieval and review sampling.
- Filters: show, category, date range, favorites-only, has-quote, duration band, archived. Sort: relevance / newest / oldest.
- **Saved searches** with "N new since last visit" badges (P4).
- Grouping toggle: by episode / by show (compare what different shows say about a query).

### 4.4 Ask — Q&A with citations (P1, P2, P4)

- Pipeline: question → hybrid retrieval top-40 (favorite-boosted) → MMR de-dup to 12 → answer.
- **With an LLM adapter** (all optional & free — Ollama local, LM Studio local, Google Gemini free tier, Cloudflare Workers AI free tier, any OpenAI-compatible URL): synthesized answer where **every claim carries a citation chip** `[Show — Episode @ 03:12]` linking to the snip page → Snipd deep link. Streamed (SSE). System prompt forbids answers not grounded in retrieved snips; must say "not found in your snips" when applicable.
- **Without any LLM (default install)**: extractive mode — retrieved snips grouped by theme (embedding clusters), best quotes surfaced. The product must be fully useful with zero keys and zero internet.
- Answer quality is gated by the eval harness (§11.3), not vibes.

### 4.5 Favorites (P1, P3, P5) — explicitly requested

- Star at **show / episode / snip** level; one keystroke (`s`) anywhere; bulk-star from lists.
- **Favorites timeline**: all favorites in chronological order (episode `last_snip_date`, then in-episode timestamp), filterable by level/show/category — the requested "all favorites in chronological order" view.
- Favorites **boost ranking** (§4.3), **pin analysis** (dashboard "favorite share" per show; Wrapped features favorite quotes), and **weight resurfacing** (§4.8).
- Optional vault convention: a `⭐` typed by the user at the start of a snip heading in the Markdown is detected on sync and imported as a star (works because Snipd preserves user edits in append mode). Off by default; Resurface still never writes to the vault.
- If Snipd ever exports a favorite flag, the importer maps it onto the same entity.

### 4.6 Themes & similarity map (P1, P2, P4)

- **Related panel** on every snip/episode page: top-k nearest neighbors (episode-level = mean of snip vectors), excluding same-episode, favorites badged.
- **Map view**: UMAP (umap-js) projection of all 32k snips to 2-D, rendered with regl-scatterplot (handles 100k+ points); zoom/pan, hover previews, lasso-select → open as a result list / save as collection; color by show, category, date, or favorite.
- **Clusters**: density clustering on the UMAP output (HDBSCAN-style); each cluster gets a label from c-TF-IDF top terms, optionally polished by the LLM adapter; cluster pages list member snips/episodes. Recomputed on demand or weekly (cached).

**As built (v0.5.0) — the related panel and hybrid search ship; the map and clusters do not yet.**

- **Model**: `Xenova/all-MiniLM-L6-v2` (384-dim, q8) via `@huggingface/transformers`, downloaded once (~25 MB) into `%LOCALAPPDATA%\Resurface\models`. Free, local, offline after the first run — no key, no upload. Measured ~35 snips/s on this machine, so 32k snips ≈ 15 min.
  - Dependency note: transformers **3.8.1**, not 4.x — the 4.x tree pulls an `adm-zip` advisory through `onnxruntime-node`, and `@xenova/transformers` v2 pulls a *critical* `protobufjs` one. 3.8.1 audits clean; check that before upgrading.
- **Storage**: migration `005_embeddings` → `snip_vectors(snip_id, model, dim, vec BLOB, text_hash)`. Vectors are derived data, so unlike snips they may be deleted and rebuilt; the model name is stamped on every row so a model swap invalidates cleanly rather than mixing spaces.
- **What gets embedded** (`embeddingText`): show title + episode title + snip title + quote + de-marked summary + the first 600 chars of transcript. Show/episode titles matter — a three-minute snip is too thin to place on its own.
- **Threads**: embedding runs in a **worker** (`embed-worker.ts`) and query embedding in a second worker (`query-worker.ts`), so the HTTP thread never loads ONNX. This was learned the hard way: running inference on the server thread froze the UI mid-build, and loading a second in-process session on top of the build worker killed the process outright. Smart search also falls back to keyword *while a build is running*.
- **Resumability**: each batch commits, so Stop/restart/crash all keep what was finished; `embedStatus` drives the dashboard card, and new snips from a sync are picked up on the next build.
- **Search modes**: Keyword (unchanged), **Smart** = reciprocal-rank fusion (k=60) of the BM25 list and the vector list with the ⭐/🔖 boost preserved, and **Meaning only** = pure vector. Filters (show, dates, tags, has-quote, starred) apply to semantic hits too, via an id-restricted second pass.
- **Nearest-neighbour search** is a brute-force scan of an in-memory `Float32Array` matrix (32k × 384 ≈ 49 MB, loaded once, invalidated as the build writes) — under 10 ms, so no vector index (sqlite-vec/HNSW) is needed at this corpus size.

**As built (v0.6.0) — topics and the map, with two deliberate deviations from the plan above.**

- **Clusters → "Topics"**: spherical k-means (k-means++ seeded, cosine, ~12 iterations, seeded PRNG so rebuilds are stable) over the vectors, k ≈ snips/900 clamped to 6–40. On the real corpus: **36 topics over 32,229 snips in under 15 seconds**, single-threaded, in a worker at below-normal priority. HDBSCAN was dropped — it needs a dependency and a density estimate, and k-means already produces coherent groups at this size.
- **Labels** are c-TF-IDF over snip titles + tags with `idf = log(k / df)`, so a term appearing in *every* topic scores exactly zero. This matters more than it sounds: the first pass used `log(1 + k/df)` and produced labels dominated by a recurring host name and by words common to the whole corpus — the ubiquitous top tag and corpus-wide words drowning the signal. With the stricter weighting the same data yields *Justification · Grace · Righteousness*, *Wealth · Money · Rich*, *Brain · Anxiety · Thoughts*, *Apologetics · Science · Relativism*.
- **Map = PCA, not UMAP.** UMAP on 32k × 384 costs minutes of CPU and a dependency; PCA by power iteration is dependency-free, deterministic, and finishes in seconds — which matters because the owner had just been burned by a CPU-hungry build. Raw PCA, though, paints one uniform cloud: mathematically faithful, visually useless. So the final layout **anchors each snip 60 % to its topic's position (spread on a ring so islands don't overlap) and 40 % to its own PCA coordinates**. Topics read as colored islands, snips still spread within them, and the caption says plainly that cross-map distance is only a rough guide. Rendering is a plain `<canvas>` (fillRect over 32k points) rather than regl-scatterplot — again, no dependency.
- **Interaction**: topic dropdown lights one island and fades the rest, hover hydrates a point into a snip preview, and the selected topic's most central snips render underneath. `/topics` lists every topic with size, shows, ⭐ counts and date range, expanding to its most typical snips.
- Not carried over from §4.6: lasso-select and colour-by-date/category (Phase 4 territory), and episode-level related panels (snip-level neighbors proved more useful in practice).

### 4.7 Auto-categorization (P1, P4)

- Taxonomy is **user-editable** and **seeded from clusters** (§4.6) — not a hardcoded generic list, so a corpus concentrated in one field gets categories shaped by that field, a startup-heavy corpus gets startup-shaped ones.
- Assignment: category centroid = mean of (label embedding + exemplar snips); a snip joins every category with cosine ≥ 0.42 (tunable), multi-label, with confidence shown. Episodes inherit the dominant categories of their snips.
- Corrections (add/remove a snip from a category, rename/merge/split categories) update exemplars → centroid — the system learns from the user.
- Category trend-over-time chart feeds the dashboard (P4).

**As built (v0.7.0) — §4.4 Ask and §4.7 categories.**

- **Ask** retrieves with the existing hybrid search and answers in one of two modes. The default is **extractive**: the best passages are quoted verbatim under `[n]` citations, so there is no model and therefore nothing to hallucinate. If `config.llm` names a local **Ollama** model it writes a ≤150-word summary over those same passages under a cite-everything prompt; when Ollama is missing, slow (60 s timeout) or errors, the quoted answer stands and the page says why. Nothing is ever sent off the machine.
- **Categories** are seeded one-per-topic and then owned by the user: rename, merge (scores max-merged), delete, pin/remove individual snips. Assignment is centroid cosine, multi-label, and pinned snips both survive re-assignment and define the centroid.
- Two calibration lessons from the real corpus, both fixed:
  - The plan's fixed `cosine ≥ 0.42` produced **730,027 assignments — 23 categories per snip**. On a thematically uniform library almost everything clears a fixed bar, and labelling everything is the same as labelling nothing. Each snip now keeps only its **top 3** matches above the threshold: 89,558 assignments, ~2.9 per snip across 36 categories.
  - A strict cutoff could *empty* a seeded category, destroying its definition and leaving it unrecoverable. Each category's centroid is now **persisted** (`categories.centroid`), so meaning survives an empty round and re-running at a lower threshold restores it. Authority order: pinned snips → current members → stored centroid.
- **Wrapped** (same release): every leaderboard is a `TopList` showing 5 by default with a 10/25/all dropdown, and the period picker now takes a **single month** as well as a year, comparing against the same month a year earlier.

**As built (v0.8.0) — snip provenance, topic labels, local-model setup, and a corruption fix.**

- **Auto vs. manual snips** (`core/snipkind.ts`, migration 008). The owner's manual notes carry section names
  like "Main Theme" and "Core Frameworks", and keying off those would have been easy — but they are *one
  user's* chosen note types, they differ per person and drift over time. So the classifier identifies Snipd's
  **machine template positively** and calls everything else hand-made. Measured over the real corpus, the
  template is extraordinarily rigid: 28,076 snips have exactly two summary bullets, 24,135 land between 200
  and 300 characters, and only **61 fall anywhere in the 400–1000 character range** — the decision boundary
  sits in that empty gap, which is why its exact value barely matters. Result: 28,111 auto / 4,085 manual,
  with **189 flagged uncertain** for review. Verified 7/7 against an episode the owner labelled by hand.
  **Duration is deliberately unused** — hand-made snips run from seconds to whole episodes.
  Kind is recomputed on every import; a user override (`kind_source = 'user'`) is permanent.
- **Ranking policy**: auto/manual is a facet and filter with **zero weight in search**, the same rule as tags
  (organising is not endorsing). It may only influence Phase 5 resurfacing through a visible quota, since a
  daily five drawn uniformly from 28k auto highlights would read as noise.
- **Topic labels no longer name speakers.** Raw c-TF-IDF named topics after recurring hosts: correct, and
  useless, because the snips aren't *about* the speaker. Two corrections, both label-only (no re-embedding):
  names the export states outright are excluded via `personTerms()` — show authors, guests, book authors and
  quote attributions, so no name detection is involved and no other user's vocabulary is assumed (possessive
  forms are folded in, which possessive forms initially defeated) — and every term is weighted by **how evenly it
  spreads across shows relative to its own topic's spread**. A term confined to fewer shows than the topic it
  labels is describing the show, not the idea; this also catches catchphrases and sponsor reads with no list
  at all, and a single-show topic is left alone because it has nothing to compare against.
- **Connecting a local model** now probes before saving (`probeOllama`), so the app can never sit in a
  connected-but-broken state — the previous flow was a `prompt()` and an unconditional write, which on a
  machine without Ollama produced "fetch failed" on every question *and* hid the connect button, leaving no
  way back. The panel is always visible, names the problem, gives the fix, and can disconnect.
- **Database corruption fix.** `openDb()` ran `PRAGMA journal_mode` and the full `migrate()` DDL on *every*
  connection — main server, embed worker, topics worker, CLI — while the embed worker wrote 32k rows, and
  nothing set a `busy_timeout`. Multiple concurrent writer connections first appeared in Phase 3, and the
  database was found corrupted with SQLite parsing a data page as the schema page. Now only the owning
  process migrates (`openDb(path, { migrate: false })` for workers) and every connection waits its turn.
  Recovery required no data loss: the vault is the source of truth and vectors are derived.

### 4.8 Resurfacing engine (P1, P5) — the "forgotten most of it" core

- **Daily review**: N snips/day (default 5). Sampling weight = `(favorite? 2.0 : 1.0) × age_decay⁻¹ × never_shown_bonus × category_diversity`. Each card: quote + summary + "why you're seeing this"; actions: keep (SM-2-lite spaced repetition: intervals 3 → 7 → 21 → 60 → 180 days, adjusted by "show me more/less"), star, archive-from-review, open in Snipd.
- **On this day**: snips from this date in prior months/years.
- **Weekly digest**: auto-generated page — new activity, emerging themes (cluster deltas), 3 resurfaced gems; LLM narrative if an adapter is configured, template text otherwise. Reachable at a stable URL for phone reading (P9); optional email is out of scope for free tier (no reliable free SMTP) — the digest is pull, not push, plus an RSS feed of digests for any reader.
- **Serendipity**: one click → oldest never-resurfaced high-signal snip (favorite-weighted).

**As built (v0.9.0) — §4.8 resurfacing.**

- **Daily review** (`core/review.ts`, migration 009). Two mechanisms, deliberately separated: *weighted sampling*
  decides what is seen (never-shown ×2.5, Snipd favorite ×2, age ≈×2/year, divided by `1 + shown²` so
  well-worn snips back off sharply rather than being excluded), and *spaced repetition* decides when it
  returns — **3 / 7 / 21 / 60 / 180 days**. A test caught a real bug here: the first "keep" skipped the 3-day
  gap and jumped to 7, because the level advanced before the interval was read.
- **`review_state` is the first table that cannot be rebuilt from the vault.** A review history is made by the
  user, not the export. That raises the stakes on backups and is an argument for an online-backup API.
- **Nothing deletes.** "Stop showing" excludes a snip from review only; it stays in the library, search, stats
  and exports, consistent with the never-delete rule.
- **Manual quota**, as agreed: 3 of 5 by default. Hand-made snips are the deliberate ones, but a review drawn
  only from 4,089 of them would never revisit the 28,123 auto highlights — which are the better source of
  surprise precisely because they weren't chosen. The batch tops up so a thin manual pool never shrinks it.
- Each batch is **seeded by the date**, so reloading doesn't reshuffle the cards, and every card carries a
  plain-language reason.
- **Digest, on-this-day, serendipity** (`core/digest.ts`). The digest's narrative is assembled from the numbers
  themselves rather than written by a model, so it is always available and always accurate — the plan's
  optional LLM narrative was dropped as a needless dependency for prose this templated. Emerging themes are
  topic counts diffed against the previous week. Gems are older, favorited and never-resurfaced, because the
  point of a digest is the back catalogue rather than the week's intake. Delivery is a **feed, not email**:
  no free SMTP is reliable, and a feed needs no account.
- **On this day is honest about its dating.** With no per-snip timestamp everything is dated by its episode's
  `last_snip_date`, and the page says so. The library only reaches back to 2026-01-26, so there is no "last
  year" yet; the empty state reports where the history actually starts instead of showing nothing.
- **Wrapped as an image** is an SVG rasterised through a canvas in the browser — no rendering library, no
  server round-trip. Verified 1080×1350, 169 KB, 3.4% ink coverage (i.e. not a blank card). Revoking the
  object URL immediately after `click()` can race the browser's own read and cancel the download, so it is
  deferred.

**As built (v0.9.1–0.9.2) — reading in place, and update reliability.**

- **Expand a snip where you find it** (`SnipDetails`, `GET /api/snips/:id/full`). Search, review, the digest,
  Starred and Ask all expand a snip in place to its full note and transcript. List endpoints deliberately omit
  transcripts — shipping 25 of them to render a page is waste — so the full content, keyed on the snip id, is
  fetched only on first open and kept after. Where the row already shows the notes and quote, expanding opens
  straight onto the transcript. Starred rows additionally show a five-line note preview when collapsed.
- **The nav is two rows**, split by activity: the daily loop (Dashboard, Search, Ask, Review, This week) at
  full size, and browsing (Library, Starred, Tags, Mentions, Topics, Categories, Map, Wrapped) quieter beneath.
  It only sticks from the `sm` breakpoint up, since two wrapped rows eat a quarter of a phone viewport.
- **Update reliability.** `Update Resurface.bat` now uses `npm ci`, not `npm install`: plain install was
  leaving `@huggingface/transformers` only partly installed (its `jinja` sub-dependency but not the library),
  which made the meaning index read as empty and trigger a full, wasteful rebuild. The script now also fails
  loudly if the embedding library is absent rather than degrading silently. Through the whole incident the
  database held all 32,196 vectors with integrity intact — the "rebuild" was a broken install, not lost data.

**As built (v0.10.0) — Phase 6 part 1, storage reliability.**

- **`VACUUM INTO` is the backup primitive**, chosen over a file copy because it writes a consistent,
  already-checkpointed database *while this process holds the original open* — no WAL to carry, no torn file.
  Measured at 2.3 s for the real 323 MB library. A useful side effect: the copy is defragmented, and the
  restored file carried a 0 MB WAL where the original had 188 MB.
- **A backup nobody has checked is a guess.** Every snapshot is written under a `.partial-` name, then opened,
  `integrity_check`ed and row-counted before being renamed into place; one that fails is discarded rather than
  replacing a good backup. A snapshot of an *empty* library is refused outright — far likelier to mean
  something broke than to be worth keeping.
- **Two tiers, because they answer different fears.** Full snapshots (~320 MB, keep 3) restore everything
  instantly with no re-embedding. `work-*.json` (**5 KB** on the real library) holds only what the vault
  cannot regenerate — review state and log, bookmarks, saved searches, category names/notes/pins, snip-kind
  overrides — so it can be written constantly and kept for months. Category *centroids* are deliberately
  excluded: derived data, and they would dominate the file size.
- **Restore never deletes.** The replaced database is renamed into a `replaced-<stamp>/` directory, because a
  restore is exactly the moment someone realises they picked the wrong backup. It runs in-process — close,
  swap, reopen, invalidate the vector matrix — and is refused while an embed or topics job holds the file.
  Verified live: 1.6 s, the app kept serving, and afterwards keyword search returned 2,270 hits, smart search
  reloaded its vectors, and the review queue still built.
- **Bug found by its own test:** two backups taken in the same second overwrote each other, since the
  timestamp only had second resolution. Names now get a numeric suffix until free.
- **On the earlier "malformed on checkpoint".** `wal_checkpoint(PASSIVE)` succeeds on a healthy file; the
  failure was specific to the already-damaged database (the one also reporting a bad freelist), not to
  checkpointing itself. A PASSIVE checkpoint now runs every 30 min so the WAL cannot reach the size where
  problems appeared. **Still open:** the underlying `node:sqlite` fragility under multi-connection access —
  mitigated by the pid lock and CLI delegation, not yet cured.

**As built (v0.11.0) — Phase 6 part 2: the root cause, honestly.**

The working theory all along was that `node:sqlite` corrupts under concurrent access. **Four controlled
experiments failed to reproduce it**, and the theory should be treated as disproved:

| Experiment | Result |
|---|---|
| Two processes, 80 write transactions, `busy_timeout` set | 80/80 committed, `integrity_check` **ok** |
| The *old* `openDb` pattern — DDL + `journal_mode` flip per connection, no `busy_timeout` | 22 `database is locked` errors, but integrity **ok** |
| `Stop-Process -Force` mid-transaction, three times | WAL recovery clean each time, integrity **ok** |
| Worker thread + main thread on one file, 120 transactions | 120/120 committed, integrity **ok** |

So concurrency here produces **lock errors, not corruption** — which is what SQLite is designed to do. The
mitigations already shipped (pid lock, CLI delegation, `busy_timeout`) were still worth having: experiment 2
shows the old code really did lose transactions. But they were not the cure, and **migrating to
`better-sqlite3` is not justified by any evidence collected** — it would be a native dependency and a Node
downgrade bought on a hunch.

What remains, by elimination, is **external interference with the file**. Windows Defender real-time
protection is on and `%LOCALAPPDATA%\Resurface\` is not excluded; a scanner touching a 300 MB database mid-write
matches the observed signature (a *data* page turning up where the schema page should be). That is a change
to the machine's security posture, so it is documented in INSTALL.md as the owner's decision, not made for
them.

**Given an unexplained failure mode, the engineering answer is detection, not a claimed fix.** `healthCheck`
runs `quick_check` five seconds after boot and every 30 minutes (~1.7 s on the real library, deferred so it
never delays startup). If a page goes bad the console says so, the dashboard shows a banner, and both name
the verified snapshot to restore — while that snapshot is still hours old rather than weeks.

**Accessibility.** An audit of the live pages found no missing alt text, no unlabelled controls, and both
landmarks present — but three real failures, now fixed: **no focus style at all** (keyboard users could tab
but not see where they were), **no `<h1>`** on Dashboard or Search, and no way past thirteen nav links.
Added `:focus-visible` outlines, a skip link, `aria-label`s distinguishing the two navs, an `sr-only`
utility, and `prefers-reduced-motion` support. Note the focus *rules* are verified present in the bundle, but
focus *behaviour* could not be confirmed in an unfocused headless window — `document.hasFocus()` is false
there, so `:focus` cannot match.

**Not done, deliberately: `npx` distribution.** Publishing to npm puts a package under the owner's name into
a public registry, which is theirs to decide, not a step to take unasked. Local install is documented in
INSTALL.md instead.

### 4.9 Collections, notes, tags (P2, P3) — NOT BUILT

*Neither collections nor per-snip notes exist: no tables, no routes, no UI. What landed instead was
**categories** (§4.7) for grouping and **bookmarks** for marking, which covered enough of the need that
ordered lists never became the thing that was missing. Left here as designed, not as shipped.*

- Collections = ordered snip lists ("Talk 2026-08-03", "Article: attention"); add from search/map/episode pages; export to clipboard/Markdown (with attributions, timestamps, share links) for pasting into Obsidian/Docs.
- Per-snip **personal note** + freeform tags, stored in Resurface's DB (the vault has none and stays untouched); indexed into both search modes.

### 4.10 Export & data ownership (P2, P7, P8)

- One-click exports: favorites.md, any collection, any search result set (MD/CSV/JSON), full-DB JSON dump.
- **Copy as Markdown** on every snip card — quote + attribution + timestamp + share link, Obsidian-flavored; one keystroke (`c`) (P2, P3).
- ~~**Quote cards**: render any quote to a shareable PNG locally~~ — **not built.** The canvas pipeline
  exists and is used by the Wrapped image; it was never pointed at individual quotes.
- ~~**Open in Obsidian** deep link (`obsidian://open?path=…`)~~ — **not built.** Every snip links back to
  Snipd instead, which is where the audio is.
- Guarantee: everything is re-derivable from (vault + user-data JSON export). **As built**, that JSON is the
  `work-*.json` written beside each backup (review history, bookmarks, categories — the rows no re-import
  can reproduce); there is no full-database JSON dump, because the database itself is the portable copy.

**NotebookLM pack (shipped v0.12.3, `core/notebooklm.ts`, panel on Ask).** A library this size cannot
simply be handed to a hosted model: NotebookLM caps a source at **500,000 words / 200 MB** and a notebook
at **50 sources free, 300 on Pro, 600 on Ultra** (Google's published limits, checked 2026-07-27). So the
export writes a folder of Markdown files — a supported source type — grouped by **show**, by **category**,
or purely by date, splitting any group too large for one source into numbered parts. Grouping is the
substance of the feature, not a convenience: NotebookLM cites the *source file*, so one file per show makes
an answer say which show it came from, while splitting by size alone produces citations that say nothing.
Alongside the sources it writes `00-about-this-collection.md` — uploaded with them — because without it the
model reads transcribed speech as the listener's own writing and snip dates as publication dates; and
`HOW-TO-IMPORT.md`, deliberately *outside* the upload folder so it never becomes a source itself.
**There is no integration to build:** consumer NotebookLM has no API. Google's Notebook API covers only the
Enterprise edition on Google Cloud, behind a paid licence, which fails the free-only constraint (§0) as well
as being a different product. Sources are added by hand, once per export.

### 4.11 People & books indexes (P1–P4) — cheap wins from existing metadata

The export already names guests and mentioned books with stable share URLs (§2.1), and the schema stores them (§6) — surfacing them is pure SQL, no ML:

- **Books** page: every book mentioned across all shows, with mention counts, the episodes/snips around each mention, and Snipd book links — "all book recommendations from my podcasts" in one view.
- **People** page: guests across shows ("which episodes feature this guest?"), linked to their episodes.
- Both filterable by favorites/category, both exportable (§4.10). Ships in Phase 2.

### 4.12 Snipd tags (P1–P4) — shipped in Phase 2.5 (v0.4.0)

Snips carry **user-defined tags applied inside the Snipd app**. The default plugin snip template ends with `{{snip_tags}}`, which renders them into the snip heading as Obsidian wiki-links: `### ⭐ [Title](url) [[notes]] [[to revisit]]`. Phase 2's parser already extracts them into `snips.tags_json`, and the episode page shows them as inert chips — but nothing else in the app knows they exist. This section closes that gap.

**Corpus reality (measured 2026-07-20, real DB):** 1,172 of 32,012 snips are tagged (3.7 %); 6 distinct tags — `notes` (1,089), `book` (73), `to revisit` (8), `ideas` (7), `quotes` (6), `exercise` (2); 13 snips carry more than one tag. Design for growth and churn, not for these six: tags are per-user, free-form, may contain spaces and mixed case, and are renamed/retired over time.

**Semantics (mirrors the Favorites/Bookmarks split, §4.5):**

- **Tags** = from Snipd, read-only in Resurface. The vault is the source of truth for any snip still present in it: removing a tag in Snipd removes it here on the next sync.
- **Labels** = tags the owner applies inside Resurface (§4.9, Phase 4), stored separately and never written to the vault. Both render as chips, visually distinguished (Snipd tag = filled, label = outlined), and both are filterable — a single "tag" filter can span the two, with the source shown on each chip.
- **Never-delete (§ import policy):** snips missing from the vault keep their last-known tags forever. A tag whose snips all vanish keeps its row and is hidden from browse at count 0 rather than deleted.

**Normalization** (one tag, one identity, no data loss):

- Match key = trim → collapse internal whitespace → strip leading `#` → lowercase. `To Revisit`, `to revisit`, `#ToRevisit`-style variants therefore converge.
- Display label = the most frequently seen original spelling, so casing stays the owner's.
- Nested Obsidian tags (`work/ideas`) are stored whole; the `/` is treated as a grouping hint in the browse UI (parent rows expandable), not as separate tags.

**Schema (migration 004, no re-parse required):**

```sql
CREATE TABLE tags (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'snipd',      -- 'snipd' | 'user' (Phase 4 labels)
  first_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE snip_tags (snip_id TEXT NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (snip_id, tag_id));
CREATE INDEX idx_snip_tags_tag ON snip_tags(tag_id);
```

`snips.tags_json` stays as the raw parser record (audit trail + cheap chip rendering); `snip_tags` is the queryable projection. The migration backfills from existing `tags_json` — no vault re-read, no `PARSER_VERSION` bump, so the upgrade is instant for existing installs. Import rewrites `snip_tags` only for snips present in the current vault scan.

**Search & filtering** (`core/search.ts`):

- `SearchFilters.tags?: string[]` + `tagMode?: "any" | "all"`, applied as an `EXISTS` subquery — no effect on BM25 ranking (a tag is organization, not endorsement, unlike ⭐).
- Inline `tag:notes` / `tag:"to revisit"` syntax parsed out of the query string before `buildMatchQuery`, so power-typing works without touching the filter bar.
- Tags are deliberately **not** added to the FTS index — otherwise every mention of the word "book" in a transcript would collide with the `book` tag.
- `tagFacets(db, q, filters)`: counts per tag for the current result set, powering a sidebar that says how many hits each tag would keep — the same query shape, grouped by `tag_id`. At 32 k snips this is a sub-millisecond index scan.
- Saved searches persist tag filters, so "new `book` snips since I last looked" becomes a badge.

**UI:**

- **/tags** — browse page: every tag with snip count, distinct shows, date range, and a sparkline; sortable; zero-count (retired) tags hidden behind a toggle.
- **/tags/:key** — detail page: that tag's snips chronologically (reusing the search-result card), with its own filter bar, export, and "bookmark this tag" for quick access.
- **Chips are clickable everywhere** — episode, show, search, starred, tag pages — one click filters to that tag.
- **Search filter bar** gains a multi-select tag control with any/all toggle and live facet counts.
- **Dashboard** gains a "Top tags" tile honoring the active period; **Wrapped** gains "your top tags this year".
- Copy-as-Markdown and MD/CSV/JSON exports include tags; a whole tag exports as one Markdown file.
- Naming caution: the `book` tag and the Mentions → Books index (§4.11) are different things — the UI labels them "tagged #book" vs "books mentioned" to keep that clear.

**Tests** (extending `search.test.ts` + new `tags.test.ts`): case/whitespace variants converging on one key; multi-tag snips; spaced wiki-link tags; tag removed in the vault disappearing from a present snip; tag retained on a vault-missing snip; renamed tag creating a new key while the old one survives at count 0; any/all filtering; facet counts matching result sets; `tag:"..."` parsing.

**Owner test checklist:** open /tags → your most-used tag shows its count; click a chip on an episode → lands filtered; search a common word then narrow by a tag and watch the count; check a snip you know is tagged in Snipd, untag it there, sync, and see the chip disappear.

**Effort:** ~0.5 week — Phase 2.5, shippable before Phase 3 since it needs no embeddings.

**As built (v0.4.0):** migration `004_tags` plus a TS backfill from `tags_json` (instant upgrade, no re-parse); `packages/core/src/tags.ts` owns normalization, sync, listing, per-tag snips and period counts; search gained `tags`/`tagMode` filters, `tag:` parsing, facet counts, and — because the FTS table now drops out of the join when there's no text — **tag-only browsing** with no keywords at all; `/tags` browse and `/tags/:key` detail pages, chips on episodes, search results, Starred rows, dashboard and Wrapped; tag Markdown export. Distribution from one real corpus, tag names generalised: the top tag carried 1,098 snips, the next 73, and the remaining four fewer than ten each — a long tail steep enough that tag facets are worth showing and tag-based ranking is not. 188 of the top-tag snips were also ⭐ favorited.

### 4.13 Phase 2.5 polish — Starred rows and a richer Wrapped

Two owner requests from testing v0.3.0, planned alongside tags (§4.12).

**(a) Starred page: lead with the podcast.** Today `EntryRow` leads with the snip's own title and demotes `Show — Episode` to a muted 11-px subtitle, which reads as a wall of context-free snip titles — you can't tell *which podcast* a favorite came from without squinting. The row inverts:

- **Primary line:** `Show` › `Episode title`, at the current title's weight, each half linked separately (show → `/shows/:id`, episode → `/episodes/:id`) and middle-truncated so a long episode title never buries the show name.
- **Secondary line:** the snip's own title plus its `@ mm:ss` timestamp, the "not in vault" badge, and the `Open ↗` share link.
- Quote blockquote stays last, unchanged.
- On narrow widths the two halves stack rather than truncate to nothing.
- `EntryRow` is shared by both tabs, so ⭐ Favorites and 🔖 Bookmarks both improve; for show-type bookmarks the primary line is just the show, with no `›` segment.
- Data is already present — `TimelineEntry.subtitle` carries `Show — Episode` from `SNIPD_FAV_SQL`. Splitting it in the UI would be fragile (show titles can contain the separator), so the timeline queries return `showTitle` and `episodeTitle` as separate fields, keeping `subtitle` for exports. Cheap: two extra selected columns, no schema change.
- The same "which podcast is this?" fix applies to search results and the Mentions pages — worth a consistency pass in the same commit.

**(b) Wrapped: more of it, and more fun.** `getWrapped` currently hard-codes `topShows … slice(0, 10)` and returns five facts. Changes:

- **Top-shows count is selectable** — 10 / 25 / 50 / All, via a `limit` query param on `/api/stats/wrapped` (default 10, `all` supported); the picker sits on the Top shows card and the bar chart scrolls inside its own container past ~25 rows. With 163 shows in the real corpus, "All" is a legitimate choice.
- **New stat cards**, all pure SQL over existing tables (no new data, no ML):
  - *Most-snipped episodes* — top N by snip count, with show and a link.
  - *Densest episode* — highest snips-per-hour, the "I couldn't stop tapping" award.
  - *Longest and shortest snip* captured, and total quotes saved.
  - *Busiest day* — "March 12: 14 episodes, 31 snips".
  - *Longest streak* of consecutive active days (reuses `computeStreaks`, already tested).
  - *New shows discovered this year* — shows whose first-ever snipped episode falls in this year, listed.
  - *One-and-done shows* — tried once, never returned to.
  - *Weekday rhythm* — snips by day of week, tiny bar row ("you snip most on Sundays").
  - *Monthly sparkline* of episodes across the 12 months.
  - *Favorites of the year* — ⭐ count and which show earned the most.
  - *Top tags of the year* (§4.12) and *books mentioned* count with the top few (§4.11).
  - *Year-over-year deltas* on the headline numbers when the prior year has data.
  - *Scale-of-time framing* — "1,556 h ≈ 65 days" and "your top show was 23 % of your hours".
- **Honesty rules still apply** (§2.3): every hour figure stays labeled Estimated vs Confirmed, and cards that can't be computed (empty year, no prior year) are omitted rather than showing zeros.
- Implementation shape: one extra `WrappedStats` object with optional fields, computed in the existing single pass over the year's episodes/snips plus a handful of small aggregate queries; the page renders cards conditionally, so partial data degrades gracefully. Shareable Wrapped **PNG** remains Phase 5 (§4.10), and these cards are designed to render into it later.
- Tests extend `stats.test.ts` against the existing hand-computed fixture ground truth: `limit` behavior including `all`, busiest day, streak, new-show detection, weekday buckets, and empty-year safety.

### 4.14 Metric honesty and short-form fairness (Phase 2.5)

**(c) "Confirmed" becomes "Snip time"; listening time is the episode-length number.** The two-bounds framing (§2.3) was technically honest but confusing in use: "Confirmed listening" reads like *the* real number when it is really just the length of the snips themselves, and it badly understates listening. New vocabulary, applied everywhere:

- **Listening time** — the headline metric, = full duration of every episode with ≥ 1 snip. Presented plainly, no "estimated" qualifier cluttering every tile, with the caveat moved into a tooltip on the label: *"Counts the full length of every episode you snipped. If you didn't finish one, this overcounts — Snipd's export contains no playback history."*
- **Snip time** — what "Confirmed" was: total time captured inside snips, overlapping ranges counted once. Tooltip: *"Total audio captured by your snips; overlapping snips counted once."* It stops being a listening bound and becomes a capture metric, which is what it actually measures.
- Mechanical rename `confirmedSec` → `snipSec` across `stats.ts`, `api.ts`, `Dashboard.tsx`, `ShowTable.tsx`, `Wrapped.tsx`, exports, and `stats.test.ts` (the arithmetic — `mergeIntervalsTotal` — is unchanged and its tests stay green). The ShowTable column header becomes "Snip time"; sort keys persisted from an older build must accept the legacy `confirmedSec` value and map it forward so nobody's saved view breaks.
- §2.3's honesty row is rewritten to match: one headline number that may overcount, one capture number, both named for what they are.

**(d) Short-form podcasts deserve to show up.** With many very short daily episodes in the corpus, every hours-ranked list is dominated by long shows and the short shows disappear — even though they may be the most-listened shows by episode count. Rather than pick one "fair" metric, the app makes the lens explicit:

- **A metric toggle on every ranking** — Hours / Episodes / Snips / Snips per hour — as a segmented control on the dashboard's per-show table (which gains an **Episodes** column) and on Wrapped's Top shows card, where the bars rescale to the chosen metric. Default stays Hours.
- **Snips-per-hour leaderboard** as its own Wrapped card — "which shows made you tap the most" — with a **minimum-volume guard** (≥ 3 episodes *and* ≥ 30 minutes total) so one 3-minute episode with two snips can't top the chart; the threshold is stated in the card's footnote.
- **Episodes-per-show card** — "you heard 214 episodes of one show" — the view where short daily shows finally win.
- **Short-form vs long-form split** — episodes bucketed by duration (< 10 min, 10–30, 30–60, 60 min+) with count, hours, and snips per bucket: answers "how much of my listening is short episodes versus long ones?"
- **Two density metrics, both labeled, never blended:** snips per *hour* structurally favors short episodes (a 3-minute episode with one snip scores 20/hr), while snips per *episode* favors long ones. Both appear side by side with a one-line note explaining the bias, instead of pretending either is neutral.
- Tests: the volume guard excludes low-volume shows from the leaderboard; duration bucketing on fixture episodes; per-hour and per-episode density computed against the hand-checked fixture values; the `confirmedSec` → `snipSec` rename covered by the existing totals assertions.

**As built (v0.4.0):** rename done end to end (`snipSec`, "Snip time"), with the legacy `confirmedSec` sort key mapped forward so a saved table view survives. The shows table gained **Avg ep**, **Snips/ep** and a note that hours favor long shows while snips/hr favors short ones. Wrapped ranks by Hours / Episodes / Snips / Snips-per-hour with a 10 / 25 / 50 / All picker, and gained the density leaderboard (3+ episodes and 30+ min guard), most-snipped and densest episodes (10-min floor), duration buckets, weekday rhythm, monthly chart, busiest day, longest streak, new shows, one-and-done shows, quotes, ⭐ counts, books, guests and year-over-year deltas. Real-corpus sanity check: the hours lens is led by long-form shows, while the density leaderboard is led by short daily shows (91/hr and 88/hr) — exactly the short-form blind spot this was meant to close.

---

## 5. Architecture & stack (all free/OSS)

```
┌─ packages/web      React 18 + Vite + Tailwind (SPA, served locally)
├─ packages/server   Hono (runs on Node locally; same routes deployable to CF Workers)
├─ packages/core     parser · repositories · pipelines · ranking · scheduler (pure TS, no IO deps)
├─ packages/cli      resurface init|import|embed|serve|export (thin wrapper over core)
└─ packages/eval     gold-query harness (§11.3) — planned, never built
```

| Concern | Choice | Why / license |
|---|---|---|
| Runtime | Node ≥ 20 LTS | Free, Windows-first friendly |
| DB | SQLite via better-sqlite3, **WAL mode**, single-writer job queue | Zero-ops, one file, prebuilt Windows binaries |
| Keyword search | FTS5 virtual tables | Built into SQLite |
| Vectors | sqlite-vec extension (int8 or f32, 384-d) | MIT, prebuilt binaries, loads into better-sqlite3 |
| Embeddings | transformers.js (`@huggingface/transformers`) + **bge-small-en-v1.5** (384-d, quantized ONNX) | Local CPU; ~30–130 MB one-time model download (needs internet once, cached forever; document cache dir). Fallback model: all-MiniLM-L6-v2 |
| LLM (optional) | Adapter interface: Ollama · LM Studio · Gemini free tier · CF Workers AI · OpenAI-compatible URL | Product fully functional with **none** |
| Projection / clustering | umap-js · density clustering on projection · c-TF-IDF labeling | MIT |
| Map rendering | regl-scatterplot | MIT, 100k+ points |
| Charts | Chart.js or Recharts | MIT |
| Watch / jobs | chokidar; in-process resumable job queue (jobs table) | Embedding pipeline is resumable & incremental; UI shows progress; app is fully usable (browse/keyword/stats) before embeddings finish |
| Packaging | `npm i -g resurface` / `npx resurface` → opens `http://127.0.0.1:7433`; optional Tauri desktop shell later (stretch) | Free |

**Monorepo**: pnpm workspaces. `core` has zero IO dependencies → unit-testable and reusable by the Workers variant.

> **Phase 0 implementation deviations (2026-07-20):** npm workspaces instead of pnpm (corepack no longer ships with current Node; npm needs zero extra setup), and Node's built-in `node:sqlite` instead of better-sqlite3 (zero native modules on Windows; the repository layer stays thin so a swap remains contained if FTS5/sqlite-vec needs dictate one in Phase 2/3). Real-vault parsing surfaced and fixed three format defects: unquoted `@` authors (invalid YAML → lenient fallback parser), unquoted `#`-prefixed titles (YAML comment → recovered from body/folder), and double-encoded UTF-8 files with outline `###` headings inside snip bodies (CP1252 mojibake repair + snip-boundary lookahead). Parser is version-stamped; version changes auto-force a full re-parse.

---

## 6. Data model (SQLite)

```sql
shows(id TEXT PK,           -- share-URL uuid; fallback: slug(show_title)
      title, author, url, image_url, created_at)
episodes(id TEXT PK,        -- share-URL uuid
      show_id FK, title, publish_date, duration_sec, last_snip_date,
      export_date, ai_description, url, image_url, file_path, file_hash,
      archived INTEGER DEFAULT 0, source TEXT DEFAULT 'snipd')
snips(id TEXT PK,           -- share-URL uuid; fallback: hash(episode_id+start+title)
      episode_id FK, ord, title, start_sec, end_sec, duration_sec,
      summary_md, quote_text, quote_attribution, transcript_md,
      created_date,          -- nullable; filled if template enrichment present
      embed_id TEXT, archived INTEGER DEFAULT 0)
guests(id TEXT PK, name, url); episode_guests(episode_id, guest_id)
books(id TEXT PK, title, author, url); episode_books(episode_id, book_id)
favorites(entity_type TEXT CHECK(IN('show','episode','snip')), entity_id TEXT,
      created_at, PRIMARY KEY(entity_type, entity_id))
categories(id PK, name, description, centroid BLOB, auto_seeded INTEGER)
snip_categories(snip_id, category_id, score REAL, source TEXT CHECK(IN('auto','manual')))
collections(id PK, name, created_at); collection_items(collection_id, snip_id, ord, note)
user_notes(snip_id PK, note_md, updated_at); user_tags(snip_id, tag)
review_state(snip_id PK, last_shown, due_at, interval_days, ease, times_shown, suspended)
saved_searches(id PK, name, query_json, last_seen_at)
import_runs(id PK, started_at, finished_at, files_seen, files_parsed, files_skipped,
      snips_new, snips_updated, snips_archived, warnings_json)
jobs(id PK, kind, state, payload_json, progress, updated_at)
settings(key PK, value_json)
-- FTS5: snips_fts(title, quote, summary, transcript, user_note)  content= external
-- sqlite-vec: snip_vec(embedding float[384]), episode_vec(embedding float[384])
```

Stats queries are plain SQL over `episodes`/`snips` with period bucketing on `last_snip_date`; add covering indexes on (show_id, last_snip_date) and (episode_id, ord).

---

## 7. API surface (local HTTP, JSON; same shape for the Workers variant)

This section was the design sketch. **As built** the surface is 74 routes — 50 GET, 21 POST, 1 PATCH,
2 DELETE — reachable from `packages/server/src/main.ts`. The shape held; the names moved:

```
stats      /api/stats/overview · /shows · /activity · /calendar · /tags · /wrapped   (not one /api/stats)
library    /api/shows · /shows/:id · /episodes/:id · /recent · /books · /people
snips      /api/snips/:id/full · /hydrate · /related · /categories · /kind
           /api/snips/kinds · /kinds/unsure                    (auto vs manual, §4.4.5)
search     /api/search?q&mode=smart|keyword|semantic&kind=auto|manual&tags…
ask        POST /api/ask            (one JSON response, not SSE — extractive by default)
meaning    /api/embeddings/status · POST /build · /stop · /api/map · /api/topics…
own data   /api/bookmarks · /categories · /saved-searches · /review · /settings/*
resurface  /api/review · POST /review/:id · /digest · /digest.xml · /on-this-day · /serendipity
export     /api/export/(favorites|tag/:key|search) · /api/export/notebooklm(/plan)
upkeep     /api/meta · /health · /backups · POST /backups/restore · /sync · /setup
```

Differences worth naming: there are no `/api/collections` or `/api/notes` (§4.9 was never built);
*favorites* split into read-only Snipd `/api/favorites/timeline` and editable `/api/bookmarks`;
Ask answers in one response rather than streaming, because the default answer is quoted text with nothing
to stream. Anything under `/api/` that does not match returns a JSON 404 — it used to fall through to the
single-page app and answer 200 with HTML, which made a typo look like a working endpoint.

Server binds `127.0.0.1` only by default (§13).

---

## 8. UI/UX

**Pages**: Dashboard · Library (Shows/Episodes/Snip detail) · Search · Ask · Map · Categories · Favorites timeline · Review · Collections · Digest · Wrapped · Import report · Settings.

- **Onboarding wizard**: pick vault folder → validation & sibling-backup warning → fast import with live counts → "you can explore now" while embeddings continue with a visible progress bar → optional LLM adapter setup (skippable, clearly optional).
- **Keyboard-first**: `/` focus search · `j/k` navigate lists · `s` star · `Enter` open · `r` review answer keys. Command palette (Ctrl+K) for pages and saved searches.
- **Empty/degraded states** designed: no embeddings yet (semantic features show "indexing… 43%"), no LLM (Ask renders extractive mode with an explainer), zero favorites (timeline explains starring).
- Snipd `<iframe>` audio embeds are **lazy-loaded on click** (privacy + performance); the default snip card is pure local text.
- Responsive layout (phone-usable for P9); PWA manifest so it installs to a home screen; accessibility: full keyboard nav, visible focus, WCAG-AA contrast, alt text. Light/dark theme from day one (near-free with Tailwind).
- **Version banner + "What's new" modal**: the UI shows the running version; after an update, a changelog modal lists what changed and what to test (feeds the owner test loop, §17).
- English-only v1; strings centralized for later i18n.

---

## 9. Pipelines (the algorithmic core)

### 9.1 Parser (`core/parser`)
- gray-matter for frontmatter; tolerant block scanner for the body (regex on `### [` snip headings + `🎧` time lines; sections `💬 Quote` / `📚 Transcript` / summary bullets / optional `Created:` line all optional).
- Must survive: missing share URLs ("Your uploads" private audio → fallback ID = hash(episode_id, start_sec, title)); article "shows"; `_`-escaped filenames; user text interleaved between snip blocks (append-mode edits); stale `snips_count`; either emoji or plain-text section headings; CRLF; BOM.
- Fail-soft per file: a malformed file yields a warning in the import report, never a crashed run. Parser is version-stamped; fixtures pin every known format variant (§11.1).

### 9.2 Embedding pipeline
- Unit = snip: embed `title + summary bullets + quote` (+ user note); transcripts > 512 tokens are chunked with 15 % overlap and mean-pooled into the snip vector (single vector per snip keeps the map and DB simple; chunk table behind a flag if retrieval quality demands it — decided by eval, §11.3).
- Batched, resumable (`jobs` table), incremental (only new/changed snips). Episode vector = mean of snip vectors. Full corpus ≈ 32k vectors — expect roughly 20–60 min on a typical CPU first run, minutes thereafter.
- **Embedding cache keyed by content hash** (`sha1(model_id + embedded_text)` → vector), stored separately from the main DB so it **survives DB rebuilds, migrations, and re-imports** — no update or schema experiment ever re-pays the hour-long first pass.
- The model stays **warm in the server process**; the first semantic query after boot loads it (a few seconds — show a loading state), subsequent queries are fast.

### 9.3 Clustering & categorization
- Weekly (or on-demand): UMAP → density clustering → c-TF-IDF labels → seed/refresh **suggested** categories (never silently rewrite user-edited taxonomy; suggestions land in an inbox).
- UMAP over 32k points runs in a worker thread and is cached; new snips are placed with `transform()` rather than recomputing. If full-corpus UMAP proves too slow, the map defaults to episode level (4,129 points) with per-cluster snip drill-in.
- Assignment thresholds and centroid updates per §4.7; all parameters in `settings`.

### 9.4 Ranking & review
- RRF + favorite boost exactly as §4.3 (single shared implementation in `core/ranking`, used by Search, Ask retrieval, and the review sampler). SM-2-lite scheduler in `core/scheduler` per §4.8.

---

## 10. Deployment profiles (free-only, in recommended order)

### Profile A — Local (primary)
`npx resurface` → browser at `127.0.0.1:7433`. Windows 10/11 first-class (the owner's OS): prebuilt native deps, watcher retry on AV file locks, optional auto-start via Task Scheduler snippet in docs. macOS/Linux supported.

### Profile B — Local + Tailscale (phone access, still free)
Docs-only feature: install Tailscale (free personal plan), bind Resurface to the tailnet interface, open `http://<machine>:7433` from the phone anywhere. Zero cloud quotas, zero code changes. **Recommended over Profile C for most users.**

### Profile C — Cloudflare free tier (optional, Phase 7)
For users wanting an always-on hosted copy. Verified free limits (2026-07): Workers 100k req/day & **10 ms CPU/request**; D1 5 GB & 5M row-reads/day; **Vectorize 5M stored dims** & 30M queried dims/mo; Workers AI 10k neurons/day; Pages static hosting; R2 10 GB.

Naïve design fails: 31,951 snips × 384 dims = **12.3M dims > the 5M Vectorize cap**. Working design:

1. **Vectorize stores episode centroids only**: 4,129 × 384 = 1.6M dims ✓.
2. Snip vectors stored **int8-quantized in D1 blobs** (~12 MB total), keyed by episode.
3. Query = embed question (Workers AI bge-small, ~1 neuron) → Vectorize top-20 episodes → fetch those episodes' snip blobs (≈ 150–300 snips) → brute-force dot products in the Worker (≪ 10 ms) → RRF with D1 FTS (LIKE/trigram or FTS5-equivalent query) → results.
4. **Bulk embedding happens locally** (Profile A) and is uploaded via a `resurface push` CLI (Wrangler), so the 10k-neuron/day cap only ever pays for queries, not for indexing 32k snips.
5. Sync: local remains the source of truth for **content**; `resurface push` publishes it one-way. But user **actions taken on the phone** (stars, review answers, notes) must not be lost: the Worker writes them to a D1 `action_log`, and `resurface pull` (also run automatically before every push) merges them into the local DB, last-write-wins per entity. Without this write-back path, phone stars would silently diverge from local — a bug in the v2 draft of this plan. Auth via Cloudflare Access (free ≤ 50 users). Cron Trigger regenerates the weekly digest.

Constraint honesty: Profile C serves **read + search + ask + review**; ingestion stays local (the vault lives on the user's disk anyway).

---

## 11. Quality strategy

### 11.1 Parser correctness
Golden-file fixtures: interview episode (guests+books), short daily episode, "Your uploads" (no share URLs), article feed, appended-file with user edits between snips, stale `snips_count`, missing quote/transcript, CRLF/BOM, emoji-vs-plain headings. Snapshot the parsed AST. **Idempotency property test: import twice → byte-identical DB dump.** Archive-flow test: rewrite fixture without one snip → soft-archived, star preserved.

### 11.2 Stats correctness
Hand-computed fixtures (small synthetic vault) asserting: both hour bounds, bucketing, streaks, density lenses, period comparisons.

### 11.3 Retrieval & AI eval harness (`packages/eval`) — NOT BUILT

*Planned, never implemented. There is no `packages/eval`, no gold-query set and no CI. Retrieval changes
have been judged by hand against the real corpus instead, which catches gross regressions and would not
catch a small one. If this project is picked up again, this is the largest missing piece of its quality
story.*

~50 gold queries hand-built from the real corpus (e.g. "snips about resisting the idolatry of success", "what did guests say about screen-time guardrails") with expected snip IDs → track recall@10 / MRR for keyword, semantic, hybrid, hybrid+favorites on every change. Categorization: stratified 100-snip manual audit → precision target ≥ 0.8 before enabling auto-assign by default. Ask: 20 Q&A checks — citation coverage 100 %, zero uncited claims, correct "not in your snips" on 5 adversarial questions. Run in CI (GitHub Actions free tier).

### 11.4 App tests
**As built:** 189 Vitest tests in `core`, over a synthetic fixture vault (`packages/core/test/fixtures/`)
that deliberately includes malformed YAML, `#`-prefixed titles, mojibake and a zero-duration episode.
No Playwright: browser flows have been checked by driving a real instance against that fixture vault
(setup → import → all thirteen pages → search → review → export), not by an automated suite.

---

## 12. Non-functional requirements

| Aspect | Budget |
|---|---|
| Initial import (4k files, no embeddings) | < 2 min |
| Keyword search | < 100 ms | 
| Hybrid search | < 500 ms |
| UI cold start | < 3 s |
| Map load (32k points) | < 4 s to interactive |
| Full embedding pass | background, resumable, app usable throughout |
| DB size @ this corpus | ≈ 300–500 MB incl. vectors & FTS |
| Licenses | all dependencies MIT/Apache/BSD; no phone-home; **no paid service anywhere in the default path** |

---

## 13. Security, privacy, data ownership

- Server binds `127.0.0.1` by default; LAN/tailnet exposure is an explicit opt-in flag. No CORS. CSP on the local UI.
- Zero telemetry. Only network calls in default setup: one-time embedding-model download; Snipd images/iframes lazy-loaded on interaction (and can be disabled entirely: "fully offline mode" renders text + local placeholder covers).
- LLM adapters clearly disclose where text goes (local adapters send nothing anywhere; Gemini/Workers AI send retrieved snippets to that provider — shown in Settings, off by default).
- Data location: `%LOCALAPPDATA%\Resurface\` (DB, embedding cache, model cache) with a settings override — keeps the repo clean and survives re-clones.
- Backup: "Export user data" (favorites, notes, tags, categories, collections, review state → JSON) + a "Backup database" button using `VACUUM INTO` (safe while the server runs under WAL); restore = vault re-import ⊕ JSON merge. Documented restore drill in README.

---

## 14. Roadmap with acceptance criteria

Estimates assume one competent full-stack TS developer, part-time; total ≈ **8–12 weeks**.

| Phase | Scope | Acceptance criteria | Est. |
|---|---|---|---|
| **0 Foundations** | Monorepo, schema+migrations, parser+fixtures, CLI import, import report (also emitted as `import-report.html` and auto-opened in the browser) | Real vault (4,129 files) imports < 2 min, 0 crashes, report lists warnings; double-import idempotent; owner runs it by double-clicking `Start Resurface.bat` | 1 wk |
| **1 Library + Stats** | Server+SPA, browse, dashboard, calendar, per-show lenses, Wrapped v0 | Owner answers "hours per show this month, past year?" from UI; both hour-bounds labeled | 1–2 wk |
| **2 Search + Favorites** | FTS5, filters, saved searches, starring, favorites timeline, exports | a common search term returns ranked cited snips < 100 ms; timeline shows all stars chronologically | 1 wk |
| **2.5 Tags + polish** ✅ shipped v0.4.0 | Normalized tag tables + backfill, tag filters/facets/`tag:` syntax, /tags browse & detail, clickable chips, dashboard + Wrapped tiles (§4.12); Starred rows led by show › episode; selectable Wrapped top-N and a dozen new stat cards (§4.13); "Confirmed" renamed to Snip time with listening time as the headline, plus metric toggles, a snips/hour leaderboard, and short-vs-long-form splits (§4.14) | Owner filters any search by a Snipd tag with live counts; /tags lists every tag with counts; untagging in Snipd propagates on sync while vault-missing snips keep their tags; every Starred row names its podcast; Wrapped shows up to all 163 shows; every ranking can be re-lensed by hours/episodes/snips/density so very short shows surface | 1 wk |
| **3 Semantic layer** ✅ shipped (v0.5.0 embeddings/related/hybrid, v0.6.0 topics + map) | Embedding pipeline+progress UI, related panels, hybrid RRF+boost, map, clusters | Eval: hybrid recall@10 ≥ keyword-only + 20 %; map interactive at 32k pts; related panel sensible on 9/10 spot checks | 2 wk |
| **4 Categories + Ask** ✅ shipped v0.7.0 | Taxonomy seeding/editing, auto-assign, LLM adapters, cited Ask, extractive fallback | Category precision ≥ 0.8 on audit; Ask cites every claim; works with zero LLM configured | 2 wk |
| **4.5 Provenance + label quality** ✅ shipped v0.8.0 | Auto/manual snip classification from note shape with a review queue and permanent overrides; speaker/host/guest names removed from topic labels via structured-field exclusion + show-entropy weighting; Ollama connection probed before saving with an always-reachable panel; "Your week" metric picker; concurrent-writer DB corruption fixed | Classifier agrees with the owner on a hand-labelled episode and never keys off one user's note vocabulary; no topic label names a speaker; a machine without Ollama cannot reach a connected-but-broken state; auto/manual changes no search ranking | 1 wk |
| **5 Resurfacing** ✅ shipped v0.9.0 | Daily review+scheduler, on-this-day, digest+RSS, Wrapped v1 PNG | 5-card review daily; "less like this" halves that category's frequency; digest regenerates weekly | 1–2 wk |
| **6 Packaging & polish** ✅ shipped v0.11.0 | **Storage reliability first** (see prep note below), automatic verified backups + restore UI, `npm ci` everywhere, onboarding wizard, a11y pass, autostart doc | Fresh Windows machine: install → insights in < 10 min; a week of daily use with zero index rebuilds or "malformed database" events | 1–2 wk |
| **7 Remote access (opt)** | Tailscale docs; Cloudflare variant per §10-C with `resurface push` | Phone search+review round-trip on free tier; documented quota math | 1–2 wk |
| **8 Stretch** | Importers (Readwise CSV, Kindle clippings, YouTube/Whisper), Tauri shell, share cards, multi-profile | — | open |

Definition of done for v1.0 = Phases 0–6. **Owner-testability is a phase exit criterion, not a Phase 6 deliverable**: every phase must be runnable via the two `.bat` shortcuts (§17) and ship a short "what to test" checklist.

**Phase 6 prep note — storage reliability is the first task, not polish.** This session hit repeated
`malformed database schema` / `database disk image is malformed` events. What was learned, and what to do:

- **Root cause is contention, not the data.** The file itself stayed intact (integrity `ok`, all 32,196
  vectors) every time it was checked with nothing else attached. The failures came from a *second* connection
  touching the file while the app held it — `node:sqlite` does not tolerate that here — and from checkpointing
  a large WAL. The pid lock (`openDb`) and the CLI-delegates-to-the-server change (`/api/sync`) already close
  the everyday paths; the WAL-checkpoint failure is still open.
- **Decision to make first:** either (a) route *every* DB access through the one server process and never open
  a second connection anywhere, or (b) move off experimental `node:sqlite` to `better-sqlite3`. (b) could not
  be installed this session — no prebuilt binary for Node 25 (ABI 141), and no VS Build Tools — so it implies
  dropping to Node 24 LTS. Lean (a) first: smaller, no native dep, matches how the app already works.
- **Automatic verified backups.** `review_state` is the one table not rebuildable from the vault, and a
  hand-restored `resurface.db.verified-backup` saved the day twice. Make this a feature: periodic
  `VACUUM INTO` a timestamped backup, an integrity check on it, and a one-click restore in the UI.
- **Reproducible installs.** `Update Resurface.bat` now uses `npm ci` and verifies the embedding library is
  present; apply the same guard to `Start Resurface.bat`.
- **Periodic checkpoint/vacuum** on a healthy single connection to stop the WAL from growing into the
  hundreds of MB, which is where checkpoint corruption showed up.

---

## 15. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Snipd changes export format | Medium | Tolerant versioned parser; fixtures per variant; fail-soft + import report; frontmatter-first parsing |
| Users edit vault files (supported by Snipd!) | High | Append-tolerant parser; body-as-truth; idempotent upserts |
| Embedding quality on niche or specialist vocabulary | Medium | Eval harness before/after; model swap path (bge-base) is one setting |
| LLM hallucination | Medium | Citation-required prompting, extractive fallback, eval gate |
| CF free-tier limits shift | Medium | Profile C optional; Tailscale profile as free remote-access alternative; quota numbers isolated in one config/doc (App. B) |
| Windows watcher/AV flakiness | Medium | Debounce+retry, manual Sync button, watcher-off mode |
| Native-module / Node version drift (better-sqlite3, sqlite-vec) | Low | `Setup.bat` pins Node LTS (winget) + corepack; `resurface doctor` verifies; Node ≥ 22 built-in `node:sqlite` kept as a fallback path |
| 32k-point map perf on weak GPUs | Low | regl-scatterplot degrades to sampled points; list fallback |
| Scope creep (this doc is large) | High | Phases are strictly ordered; each independently shippable & useful |

---

## 16. Open questions for the owner

1. **Favorites source**: is the in-app star (plus optional vault `⭐` convention) sufficient, or do you favorite inside Snipd today and want that upstream data pursued (feature request to Snipd)?
2. Should the Snipd plugin's **snip template be customized now** to add a per-snip `Created:` date (if the variable exists) so future stats gain per-snip dates? (Past snips would still lack them.)
3. Ask/LLM: comfortable configuring **Ollama locally**, or prefer zero-setup extractive mode until Phase 7?
4. Is phone access (P9) important enough to schedule Phase 7 immediately after Phase 5?
5. Naming: keep "Resurface" or rename before repo creation?

---

## 17. Owner test loop — a few clicks per phase

The owner must be able to try every phase without a terminal workflow. This is a first-class requirement with its own acceptance criteria (§14):

- **One-time setup** — `Setup.bat`, run once (~5 min, guided output): checks/installs Git and Node LTS via winget, runs `corepack enable` (provides pnpm), clones the repo, creates two desktop shortcuts. Nothing else is ever installed manually.
- **Per release, one double-click**: `Update Resurface.bat` = git pull → install deps only if the lockfile changed → build → migrate → start server → open browser. `Start Resurface.bat` = the same without pulling. That is the entire workflow for testing each new phase.
- **Migrations run automatically on boot** and must never require manual DB steps. If a migration can't upgrade in place, the app self-heals: auto-export user data (JSON) → rebuild DB from the vault → re-import user data. Worst case is a progress bar, not a support call. The **embedding cache (§9.2) survives all of this**, so no update ever re-costs the hour-long embedding pass.
- **Per-phase release ritual** (developer): tag a release, update the in-app changelog plus a ~10-line "What to test" checklist that appears in the What's-new modal (§8) on first launch after updating. CI (GitHub Actions free tier) runs unit tests + Playwright smoke on every push, so `main` is always safe to pull.
- **`resurface doctor`** (CLI command *and* a Settings button): verifies Node version, vault path, SQLite extension loading, model cache, and port availability (auto-falls back from 7433 if taken); prints copy-pasteable fixes.
- Project licensed **MIT**.

---

## Appendix A — Parsing spec details

- Snip heading: `###  [<title>](https://share.snipd.com/snip/<uuid>)` (note double space tolerance); time line `🎧 HH?:MM:SS - HH?:MM:SS (dur)`; iframe embed UUID ≠ snip UUID (ignore embed UUID except as fallback).
- Quote block: blockquote lines, then `— <attribution>`, then optional caption paragraph.
- Transcript: `**Speaker:**` labeled or plain prose; may be absent.
- Episode fallback ID when no share URL: `sha1(show_title|episode_title|publish_date)`.
- Dates are date-only, interpreted in local timezone; `episode_export_date` is a naive local datetime.
- Ignore: `README.md`, `metadata.json`, `Base/`, `.obsidian/`, any sibling folder whose name matches `/backup/i` (with a UI warning listing what was ignored).

## Appendix B — Free-tier reference (verified 2026-07-20)

Cloudflare: Workers 100k req/day, 10 ms CPU/req · D1 5 GB, 5M row-reads/day, 100k writes/day · Vectorize 5M stored dims, 30M queried dims/mo · Workers AI 10k neurons/day · KV 1 GB · R2 10 GB. Readwise: no permanent free plan (trial only). NotebookLM free: 50 sources/notebook, 100 notebooks, 50 chats/day. Tailscale: free personal plan (up to 3 users / 100 devices). All numbers live in `docs/free-tiers.md` in-repo, dated, with re-verification notes.

## Appendix C — What the self-review pass changed (v1 → v2)

The v1 draft was critiqued before finalizing; material changes: defined the two-bound **listening-time model** and honesty rules (v1 had undefined "playtime"); designed **idempotent upserts + soft-archive deletion semantics** for Snipd's append/replace sync (v1 ignored); specified **favorites mechanics and the exact ranking boost** (v1 hand-waved); **fixed the Cloudflare design** after the dim-math showed 12.3M > 5M Vectorize cap (two-stage episode-centroid retrieval + local bulk embedding); added **onboarding/progress UX** so the app is useful before the long first embedding pass; added **import report**, **eval harness with numeric gates**, **backup/restore**, **security posture** (localhost bind, lazy iframes, offline mode), enumerated **parser edge cases** found in the real vault (private uploads, article feeds, sibling backup folder, stale counts, interleaved user edits), added the **hours/count/density stat lenses** for a corpus skewed toward short episodes, the **scenario→feature→phase matrix**, the **Tailscale profile**, and the interim-setup appendix below.

**v2 → v3 (third pass, owner-requested):** fixed a real design bug — Profile C let phone users star/review against D1 with no path back to the local source of truth (now: D1 action log + `pull` merge, §10-C); fixed an honesty slip ("longest episode *finished*" → "longest episode *snipped*" — finishing is unknowable per §2.3); added §17 **owner test loop** (Setup/Update/Start `.bat` flow, auto-migrations with self-healing rebuild, per-phase what-to-test checklists) and made owner-testability a phase exit criterion starting at Phase 0 (`import-report.html`); added the **embedding cache** so rebuilds never re-pay the first-pass hour; added **People & books indexes** (§4.11 — high value, pure SQL; the metadata was already in the schema but no feature used it); plus copy-as-Markdown, quote-card PNGs, Open-in-Obsidian links, recently-added feed, dark mode, version banner/changelog modal, episode-description FTS, warm-model note, UMAP worker/caching strategy, `VACUUM INTO` backups, the `%LOCALAPPDATA%` data directory, a native-module risk row, and the streak-crediting caveat.

## Appendix D — Interim setup (useful today, while building)

The vault already lives in Obsidian with BRAT. Until Phase 3 exists: install **Smart Connections** (free core) for local-embedding related-notes and semantic search over the same files, and use the plugin's **Bases** views for sortable episode tables. This covers a slice of search/related needs immediately and validates appetite for the full product; none of it is throwaway (Resurface reads the same vault).
