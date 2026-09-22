# Trio

## Hosted web workspace

[Open the private Trio app](https://trio-intelligence-workspace.treads77.chatgpt.site). The React/TypeScript app lives in [web/](web/README.md), with Council, Quick synthesis, Compare, connection settings, and a no-key demo. For local development, run `cd web`, `pnpm install`, then `pnpm dev`.

## Python application


Ask one question, get one answer written by three AIs working together.

Claude, ChatGPT and Gemini each answer your question independently, then
read one another's answers (anonymised, so nobody favours its own) and flag
errors, gaps and disagreements. Finally one of them writes a single answer
from all the drafts and reviews. You see the combined answer first, and can
expand "See what each model said" to compare the originals.

## How it works

```
            ┌─ Claude  ─┐        ┌─ Claude  ─┐
question ──▶│  ChatGPT  │───────▶│  ChatGPT  │───────▶ one model writes
            └─ Gemini  ─┘        └─ Gemini  ─┘         the final answer
             1. draft             2. peer review        3. synthesis
             (in parallel)        (drafts anonymised)
```

- A model failing never sinks the run: Trio continues with whoever answered.
- With only one working model, its draft is returned directly.
- Untick "Have them review each other" (or send `"thorough": false`) to skip
  the review round — faster and roughly half the cost.

## Run it locally

```bash
pip install -r requirements.txt
cp .env.example .env        # add your API keys
uvicorn main:app --reload
```

Open http://localhost:8000. Trio uses whichever of the three vendors have a
key in `.env`; set all three for the full effect.

No keys yet? Try demo mode with fake answers:

```bash
TRIO_MOCK=1 uvicorn main:app --reload
```

There is also a command line:

```bash
python cli.py "Should I refinance at 5.1% with 22 years left?"
python cli.py --quick "..."     # skip the peer-review round
```

## Configuration

Everything is set through environment variables (or `.env` locally) —
see [.env.example](.env.example) for the full list.

| Variable | Default | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | — | Enables that model |
| `CLAUDE_MODEL` / `OPENAI_MODEL` / `GEMINI_MODEL` | `claude-opus-5` / `gpt-6-astra` / `gemini-3.8-flash` | Which model each vendor uses |
| `SYNTHESIZER` | `claude` | Who writes the final answer (`claude`, `openai` or `gemini`) |
| `APP_PASSWORD` | off | Require this password on every API call — **set it before deploying** |
| `TRIO_MOCK` | off | `1` = demo mode, no keys needed |
| `MAX_OUTPUT_TOKENS` | `4000` | Response length cap per model call |
| `MODEL_TIMEOUT_SECONDS` | `240` | Per-call timeout |
| `MAX_CONCURRENT_RUNS` | `8` | Simultaneous questions per server instance |
| `TRIO_DB` | `./trio.db` | SQLite file for saved conversations; use a persistent volume in containers |

## API

`POST /api/ask` with `{"question": "...", "history": [], "thorough": true, "stream": true}`.
With `stream: true` (what the UI uses) the response is Server-Sent Events:
`start`, then per model `draft_start` + `draft_delta` chunks ending in a
`draft` event with the complete text, a `review` per model, then the final
answer streams in as `final_start` + repeated `final_delta` chunks, and one
`final` event carries the complete text, ending with `done`. A repeated
`draft_start`/`final_start` for the same model means that answer restarts
from scratch. The `final` event also carries `usage`: per-model and total
tokens, with an estimated dollar `cost` when every model used is in the
price table in [providers.py](providers.py) (otherwise `cost` is null).
Consumers should ignore event types and fields they don't recognise. With
`stream: false` you get a single JSON object with `answer`, `written_by`,
`drafts`, `reviews`, `usage` and `seconds`.

`GET /api/status` reports which models are configured; `GET /healthz` is the
health check. If `APP_PASSWORD` is set, send it as the `X-App-Password` header.

## Saved conversations (Python app)

Completed answers are saved to SQLite with their drafts, reviews, model metadata,
timing, and any usage information. The browser URL becomes `/c/<random-id>`;
refreshing or opening that link restores the full conversation. A shared link
opens read-only; **Continue conversation** enables another question. **Copy
conversation link** copies its URL, and **New conversation** starts a separate
thread without deleting the old one. Incomplete or failed answers are not saved.

There are no individual accounts: the unguessable link is a bearer capability.
Anyone with that link can read or continue the conversation, and must also know
`APP_PASSWORD` when it is set. The HTML shell contains no saved content; reads
use the password-gated API and are marked `no-store`. Keep links private when
the content is sensitive. Prompts and answers are stored unencrypted on the
server's disk; API keys are not part of the records. Back up the database to
retain conversations. The hosted `web/` workspace uses its separate opt-in
browser history and does not share this SQLite database.

`GET /api/conversations/<id>` returns the saved turns. Send `conversation_id`
with `POST /api/ask` to continue using the stored history. Optional
`expected_turns` rejects a stale tab with HTTP 409 before calling models. A
concurrent change during generation returns `save_error` without overwriting
the other answer. The browser keeps the unsaved answer visible for copying.
Streaming responses add `saved` after `final`, carrying `conversation_id` and
`turn_count`, or `save_error` if storage fails, then `done`. JSON responses carry
those fields directly. A save failure never masquerades as a saved link.

## Deploy

A `Dockerfile` is included and respects `PORT`, so Railway, Cloud Run, Fly.io
and similar all work as-is. Two things before you expose it to the internet:

1. **Set `APP_PASSWORD`** — anyone who can reach `/api/ask` is spending your
   API credits.
2. Each thorough question makes ~7 model calls, so watch your spend; lower
   `MAX_CONCURRENT_RUNS` if you need a tighter cap.
3. Mount a persistent volume and set `TRIO_DB` to a file on it. Railway and
   Cloud Run container filesystems can be ephemeral; an unmounted database may
   disappear on restart or redeploy. Keep SQLite on one server instance with a
   supported local volume; use a shared database before scaling across hosts.

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

The tests run the whole pipeline in mock mode — no keys, no network.
Each test uses a temporary database. With Playwright installed, browser checks
can also run against a local mock server on port 8000 started with
`APP_PASSWORD=local-browser-test` and a disposable `TRIO_DB` path:
`node tests/browser-conversations.mjs`. Set `PLAYWRIGHT_MODULE` to a bundled
Playwright module URL if needed; the default browser channel is Microsoft Edge.

