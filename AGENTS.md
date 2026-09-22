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

## Rules of the road

- **Run `pytest` before pushing.** Tests must pass offline with no API keys
  (they run under `TRIO_MOCK=1`). CI runs them on every PR.
- **The event stream is the contract.** Events: `start`, `draft_start`,
  `draft_delta`, `draft`, `stage`, `review`, `final_start`, `final_delta`,
  `final`, `error`, plus the SSE-only `done`. A repeated `draft_start` or
  `final_start` means that answer restarts from scratch (a stream broke and
  a non-streaming retry is replacing it). Three consumers must stay in sync when you touch them:
  `static/index.html` (`handle()`), `cli.py`, and `run_to_completion()` in
  `orchestrator.py`. Unknown event types must be ignored gracefully by every
  consumer, so *adding* a type is cheap; renaming or removing one is a
  breaking change — update all three and the README's API section.
- **Keep mock mode working.** Every feature must be demoable with
  `TRIO_MOCK=1` and no keys, and testable that way.
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

## Running things

```bash
pip install -r requirements-dev.txt
TRIO_MOCK=1 uvicorn main:app --reload   # demo server, http://localhost:8000
TRIO_MOCK=1 python cli.py "question"    # demo CLI
pytest -q                               # tests (offline)
```
