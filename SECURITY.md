# Security

## Shape of the thing

Resurface is a local application. The server binds to **127.0.0.1** only, so it is not reachable from your
network unless you deliberately put something in front of it. There is no account, no login, no telemetry,
and no outbound request except two you can see:

- downloading the embedding model once, from Hugging Face, into `%LOCALAPPDATA%\Resurface\models`;
- talking to a local Ollama, *only* if you connect one.

Your Snipd vault is opened **read-only**. The database, backups and model cache live under
`%LOCALAPPDATA%\Resurface\` and are excluded from version control.

Because it binds to localhost with no authentication, treat anyone with an account on your machine as
having full access to your library.

## Known advisories in dependencies

Re-checked with `npm audit` at **v0.12.4 (2026-07-27)**: 4 open — 2 moderate, 2 high. Reported as they
stand rather than hidden, with what each one actually means here:

| Package | Severity | Status |
|---|---|---|
| `sharp` / libvips | High (×2) | **No upstream fix.** Pulled in by `@huggingface/transformers`, which uses it for *image* input. Resurface only ever embeds text, so this code path is never entered — but the dependency is installed, so the advisory counts. |
| `react-router` 6.30.4 | Moderate (×2) | Open redirect via backslash in `<Link>`/`useNavigate`, and constructor injection in `deserializeErrors()` during SSR hydration. **Both are open against the installed version**; the advisory range is 6.0.0 – 7.17.0, so fixing them needs React Router ≥ 7.18 — a major migration that has not been done. `npm audit fix` does not resolve them (verified by dry run). The app renders no user-supplied URLs, does no SSR, and every link comes from your own vault. |

An earlier version of this file said the hydration advisory had been "patched within v6". That is no longer
true of the installed version, and the table above replaces it.

One advisory **was** genuinely fixed, in v0.11.0: `@hono/node-server` path traversal in `serve-static` on
Windows via encoded backslash — upgraded 1.x → 2.0.12. That one mattered; it was in the static file server
this app actually uses, on the platform it targets.

None of these are remotely reachable: the server listens on 127.0.0.1 with no authentication, so anyone in a
position to exploit them already has an account on your machine and, with it, your database.

Run `npm audit` yourself any time; the lockfile is committed, so you get the same answer.

## Reporting something

This is a personal project without a security team. If you find a problem, open an issue on the repository.
Please don't include anything from your own library in the report.
