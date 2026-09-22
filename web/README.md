# Trio — Collective intelligence

A private online workspace for OpenAI, Claude, and Gemini. Ask once, get independent perspectives, review disagreements, and combine the strongest ideas.

## Use the app

1. Open Connections and add API keys for the providers you want to use.
2. Turn Demo mode off. Keys stay in the current tab's memory and are cleared on reload.
3. Choose Council (drafts → reviews → synthesis), Quick synthesis (drafts → synthesis), or Compare (drafts only).
4. Ask your question. Optionally attach a text, Markdown, CSV, JSON, or code file under 60 KB.
5. Inspect perspectives and reviews, copy individual code blocks, or export the session as Markdown with run notes and fallback labels. Answers render Markdown headings, lists, links, and tables; raw HTML and embedded images are disabled.

The demo uses explicitly labeled, prepared sample responses. It never calls a model and does not answer arbitrary prompts. Live requests require API access and available credits at each provider. Consumer subscriptions do not supply these keys automatically.

## Local development

Node 24+ and pnpm 11 are recommended.

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173. No server API-key environment variables are needed: each user supplies their own keys per browser session. Do not commit keys.

```sh
pnpm test
pnpm typecheck
pnpm build
```

The app uses React, TypeScript, Vinext, and Cloudflare Workers. The POST /api/ask endpoint streams stage updates as newline-delimited JSON. Provider calls happen server-side to fixed vendor endpoints; API keys are never sent to another vendor, logged, or saved by the app. Production access is controlled by the private Sites deployment.

## Data and limits

- Prompts, attached text, and recent live conversation context are sent to enabled providers. Drafts and reviews are shared among participating providers.
- Keys live in browser memory and in server request memory while a run is active. Reloading clears them.
- Sessions live in browser memory unless you explicitly enable local history. Local history is device-specific, includes prompts and answers, and does not include API keys or the original attachments (answers may quote them). Refresh restores the active session after validating saved records. Clear history with the sidebar trash button and confirmation.
- Each follow-up includes at most six recent live question/answer pairs, including the model perspectives from Compare runs; demo content is excluded. Prior answers are capped at 30,000 characters per turn.
- Each question is limited to 20,000 characters; attached text to 60,000 characters. Provider timeouts are 120 seconds per call.
- Three connected models use seven calls in Council, four in Quick synthesis, or three in Compare. Synthesis failover can add up to two calls. Each vendor bills its own usage.
- Live results include a usage panel with attempted calls, reported input/output tokens, and a per-model breakdown. Missing provider metadata and failed requests are explicitly marked as partial usage. Gemini thinking tokens count as output; OpenAI reasoning tokens are already included in its output total. Usage is included in local history and Markdown exports.
- Standard-rate USD estimates are shown only when every attempt reported usage and all models have a known, unexpired uncached rate. They exclude discounts and taxes. Cached usage, unknown models, missing metadata, and expired rates display no cost estimate; provider invoices remain authoritative. Current rates were checked September 22, 2026 against [OpenAI](https://developers.openai.com/api/docs/models/gpt-6-astra), [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing), and [Google](https://ai.google.dev/gemini-api/docs/pricing). The table expires January 1, 2027, before using outdated introductory rates.
- A failed provider does not stop the others. If all synthesis attempts fail, an independent draft is explicitly labeled as a fallback.
- Text and code collaboration are supported. This version does not browse the web, execute code, generate images, or expose every feature of the vendors' consumer apps.
- Model agreement is not verification. Important claims and decisions still need checking.

## Validation

Nineteen deterministic tests cover the pipeline, provider failures, synthesis failover, shared context, comparison, no-key rejection, error-message redaction, saved-record validation, exports, vendor usage normalization, partial totals, cache handling, and price expiration. Browser tests cover desktop/mobile layout, the demo, tabs, connection controls, key non-persistence, history restoration, request validation, Markdown safety, code copying, attachment isolation, and usage details.

Run browser checks with Playwright installed separately and a local dev server running:

```sh
node tests/browser-smoke.mjs
node tests/browser-quality.mjs
```

The script defaults to Microsoft Edge. Set PLAYWRIGHT_CHANNEL for another installed Chromium channel, and optionally PLAYWRIGHT_MODULE to a module URL if using a bundled Playwright installation.

Real paid API calls have not been verified without user-provided keys. Model availability depends on each account; model IDs are editable in Connections.

## API references

- [OpenAI Responses API](https://developers.openai.com/api/docs/quickstart)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Gemini Interactions API](https://ai.google.dev/gemini-api/docs/get-started)

## Hosting

The .openai/hosting.json manifest identifies this private Sites app. Keep its project ID when updating this deployment. The production build is packaged from dist/ and deployed with the Sites publishing workflow. Sharing changes are separate from publishing.
