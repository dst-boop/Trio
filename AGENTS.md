# Working on Trio

Guidance for AI coding agents (Codex, Claude Code) and humans alike.

## What this is

Trio fans one question out to Claude, ChatGPT and Gemini in parallel, has
them peer-review one another's drafts (anonymised as Response A/B/C), and
one model writes the final answer. `orchestrator.run()` is the heart: an
async generator of plain dict events that drives all three frontends.

## Layout

| File | Role |
| --- | --- |
| `orchestrator.py` | draft → review → synthesis pipeline; emits events |
| `providers.py` | one plain-HTTPS adapter per vendor + mock mode; no vendor SDKs |
| `main.py` | FastAPI app: serves the UI, `/api/ask` (SSE or JSON), `/api/status`, `/healthz` |
| `static/index.html` | the whole web UI, one file, no build step |
| `cli.py` | terminal frontend |
| `tests/test_trio.py` | end-to-end tests in mock mode |
| `conversations.py` | SQLite saved conversations, atomic append, event collection |
| `tests/test_conversations.py` | Persistence, authorization, and conflicting updates |
| `web/` | Hosted React/TypeScript workspace; Cloudflare Workers-compatible Vinext app |
| `web/lib/orchestrate.ts` | Hosted multi-provider pipeline with request-scoped API keys |
| `web/app/api/ask/route.ts` | Hosted NDJSON endpoint; distinct from the Python SSE API |
| `web/tests/` | Offline orchestration tests and browser smoke checks |

## Rules of the road

- **Run `pytest` before pushing.** Tests must pass offline with no API keys
  (they run under `TRIO_MOCK=1`). CI runs them on every PR.
- **The event stream is the contract.** Events: `start`, `draft_start`,
  `draft_delta`, `draft`, `stage`, `review`, `final_start`, `final_delta`,
  `final`, `error`, plus the SSE-only `done`. A repeated `draft_start` or
  `final_start` means that answer restarts from scratch (a stream broke and
  a non-streaming retry is replacing it). Three consumers must stay in sync when you touch them:
  `static/index.html` (`handle()`), `cli.py`, and `collect_event()` in
  `conversations.py`. Unknown event types must be ignored gracefully by every
  consumer, so *adding* a type is cheap; renaming or removing one is a
  breaking change — update all three and the README's API section.
- **Keep mock mode working.** Every feature must be demoable with
  `TRIO_MOCK=1` and no keys, and testable that way.
- Python web responses additionally emit `saved` or `save_error` after `final`.
  The CLI may ignore these storage events. Saved reads and continuations must
  use `check_password`; never embed protected conversations in the HTML shell.
  Tests use an isolated `TRIO_DB` through `tests/conftest.py`.
- **Degrade gracefully.** One model failing must never sink a run. Streams
  fall back to non-streaming calls; synthesis falls through the other
  models, then the longest draft.
- **No vendor SDKs.** Providers are plain `httpx` calls so there is nothing
  to keep in sync except model names in `.env`.
- **No secrets in the repo.** Keys live in `.env` (gitignored); document new
  settings in `.env.example` and the README table.
- Work on a branch, open a PR to `main`, keep PRs focused. If another
  agent's PR is open, don't duplicate its scope — build on it or pick a
  different issue.

## Hosted workspace

- Run commands from `web/`: `pnpm install --frozen-lockfile`, `pnpm test`,
  `pnpm typecheck`, and `pnpm build`. Use Node 24 and the pnpm version in
  `web/package.json`. GitHub Actions checks the Python and hosted apps.
- The hosted app is independently deployable. Keep the Python CLI, server,
  and Docker setup working when changing it. Changes under `web/` must not
  overwrite the Python app at the repository root.
- The hosted endpoint streams NDJSON, while Python streams SSE. Do not
  assume their event shapes are interchangeable. Update the relevant
  consumer and tests when changing either contract.
- Hosted demo mode uses explicitly labeled prepared examples and no API
  keys; it is separate from the Python `TRIO_MOCK=1` environment setting.
- Never persist browser API keys in localStorage, sessionStorage, history,
  logs, or source. Keys are request-scoped and go only to their own vendor.
  Keep demo answers out of live conversation context.
- `web/.openai/hosting.json` identifies the deployed private Site. Reuse
  its identity, preserve its audience, and publish through the Sites
  workflow after hosted app changes. Repository CI checks builds; it does
  not automatically deploy. Verify the published source matches `web/`.

## Running things

```bash
pip install -r requirements-dev.txt
TRIO_MOCK=1 uvicorn main:app --reload   # demo server, http://localhost:8000
TRIO_MOCK=1 python cli.py "question"    # demo CLI
pytest -q                               # tests (offline)
```
