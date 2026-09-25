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

## Two apps, one product

The repository root and `web/` are two implementations of Trio, and they are
**not** converging. The hosted app is where product work happens; the Python
root is **maintenance only** - keep it working, fix its bugs, do not port
hosted features into it unless the owner asks. Neither is a reference
implementation of the other.

Read the table before assuming a feature exists on both sides. When you add
something to one app, update the row here in the same PR: a divergence
recorded is a decision, an unrecorded one is drift.

| Capability | Python root | Hosted `web/` |
| --- | --- | --- |
| Answer modes | Council, Quick (`thorough: false`), single model via `models` | Single, Quick synthesis, Council, Deep Council, Compare |
| Remembered mode and preferred model | no | private account preferences; first-use Single answer, no automatic paid runs |
| Deep Council revision round | no | yes |
| Web research, attachments, audio, image generation | no | yes |
| Personal memory, work briefs, action plans, value ledger | no | yes |
| Draft a checklist from a saved answer | no | one explicit provider call; review, use in editor, then save; no inferred completion |
| Dated next-action view | no | local-calendar groups, search, explicit completion/reopening, linked source plans |
| Action handoff and daily planning | no | local checklist copy/download; review a brief from visible open actions before explicitly asking a model |
| Draft/recovery confirmations | no | in-app dialogs preserve drafts on cancel and re-check removal/reveal targets |
| In-app quality evaluation | no | yes |
| Blinded comparison on user-supplied work with saved human ratings | no | yes, separate from exact-answer checks |
| Access control | shared `APP_PASSWORD` | invite-only accounts |
| Provider keys | server-side `.env`, shared by every caller | per-account encrypted, resolved per request; optional workspace-provided fallback |
| Saved history | SQLite; the unguessable link is the capability | per-account online history + V6 portable backups |
| Deleting a conversation | `DELETE /api/conversations/<id>` | Delete session in the UI |
| Wire format | SSE (`data:` frames, terminal `done`) | NDJSON |
| No-key demo | `TRIO_MOCK=1`, generated fake answers | Demo mode, prepared labeled examples |
| Claude prompt caching | yes, on draft calls with history | no |
| Per-address rate limit | yes (`ASK_RATE_LIMIT_PER_MINUTE`) | no; invite-only, per-account keys |

The two wire formats are separate contracts. The event names overlap because
the pipelines are alike, not because the payloads are interchangeable - never
port a consumer from one to the other without reading both.

## Hosted workspace

- **Invite-only access is the owner's current requirement.** Keep the Sites
  audience `custom` and preserve its invitation allowlist. Do not enable public
  access unless the owner explicitly requests that change in a later instruction.
  Adding accounts must be by invitation; a deployment is not permission to open
  registration. Keep personalization private to each account and controllable by
  its user. Do not claim that model agreement guarantees accuracy or no bias.

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
- Never persist plaintext API keys in localStorage, sessionStorage, history,
  backups, exports, logs, or source. The owner explicitly requires remembered
  keys: signed-in users may opt in to server-side account-scoped encrypted
  storage, with the encryption master held separately as a Sites runtime secret.
  Saved-key reads return metadata only; authenticated, account-pinned requests
  resolve secrets server-side and send each only to its own vendor. Provide
  replacement/deletion, stale-write protection, and temporary unsaved overrides.
  Keep demo answers out of live conversation context.
- **Trio drafts; the user executes.** The product prepares deliverables,
  plans, and next actions; export/copy is the handoff. Completion and
  outcomes are recorded by the user and labeled as user-reported — never
  inferred from generated text, model agreement, or votes, and never
  presented as measured productivity or accuracy. Do not claim to send
  messages, change calendars or records, or schedule reminders where no
  integration performs and verifies that action.
- Any future connector that acts outside Trio (mail, calendar, CRM, files)
  must use least-privilege authorization, require explicit user approval
  for each externally consequential action, be idempotent under retries,
  and record a receipt of what was done. Permission to connect is distinct
  from permission to execute: persistent OAuth connections are acceptable;
  standing execute-without-approval authority is not. This governs external
  effects only — it adds no approval gates for reversible edits inside Trio.
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
