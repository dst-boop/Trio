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

## API

`POST /api/ask` with `{"question": "...", "history": [], "thorough": true, "stream": true}`.
With `stream: true` (what the UI uses) the response is Server-Sent Events:
`start`, then per model `draft_start` + `draft_delta` chunks ending in a
`draft` event with the complete text, a `review` per model, then the final
answer streams in as `final_start` + repeated `final_delta` chunks, and one
`final` event carries the complete text, ending with `done`. A repeated
`draft_start`/`final_start` for the same model means that answer restarts
from scratch. Consumers should ignore event types they don't recognise. With `stream: false` you get a
single JSON object with `answer`, `written_by`, `drafts`, `reviews` and
`seconds`.

`GET /api/status` reports which models are configured; `GET /healthz` is the
health check. If `APP_PASSWORD` is set, send it as the `X-App-Password` header.

## Deploy

A `Dockerfile` is included and respects `PORT`, so Railway, Cloud Run, Fly.io
and similar all work as-is. Two things before you expose it to the internet:

1. **Set `APP_PASSWORD`** — anyone who can reach `/api/ask` is spending your
   API credits.
2. Each thorough question makes ~7 model calls, so watch your spend; lower
   `MAX_CONCURRENT_RUNS` if you need a tighter cap.

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

The tests run the whole pipeline in mock mode — no keys, no network.

