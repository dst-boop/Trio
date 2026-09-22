# Trio — Collective intelligence

A private online workspace for OpenAI, Claude, and Gemini. Ask once, get independent perspectives, review disagreements, and combine the strongest ideas.

## Use the app

1. Open Connections and add API keys for the providers you want to use.
2. Turn Demo mode off. Keys stay in the current tab's memory and are cleared on reload.
3. Choose Council (drafts → reviews → synthesis), Deep Council (drafts → reviews → revisions → synthesis), Quick synthesis (drafts → synthesis), or Compare (drafts only).
4. Ask your question. Optionally attach a text, Markdown, CSV, JSON, or code file under 60 KB, and one PNG, JPEG, or WebP image under 4 MB. Images must be no larger than 8,000 pixels on either side. The preview shows exactly which image is attached.
5. Inspect perspectives, reviews, and Deep Council revisions, copy individual code blocks, or export the session as Markdown with run notes and fallback labels. Answers render Markdown headings, lists, links, and tables; raw HTML and embedded images are disabled.
6. Expand **earlier questions** to inspect any previous answer, original perspectives, peer reviews, revisions, usage, and run notes without changing your current question. Earlier contributions remain readable while a follow-up runs.
7. If browser history cannot be saved, a persistent notice offers an export. The last successful saved copy is retained; recent changes remain in the current tab. Export important sessions before closing it. Long conversations are limited by storage size rather than a 200-question cutoff.

Deep Council adds one bounded revision round. Each participating model sees the original anonymized drafts, its own draft label, and the completed peer critiques; revisions run independently. Models are asked to correct supported errors and describe substantive changes and remaining uncertainties. Synthesis receives both original and revised answers. Extra deliberation increases time and API usage; it does not verify facts or guarantee a better answer. Research remains optional and runs before the collaboration stages.

An attached image is sent to each participating model at every stage, including reviews, revisions, synthesis, and recovery attempts. It remains attached for follow-ups until removed, a different session is opened, or the page is refreshed. This adds image-token usage on each call. Only the image filename is saved with a completed turn; image bytes are never stored in browser history or exports. Reattach the original when revisiting visual details. Demo ignores image attachments and remains a prepared text example.

If no peer reviews succeed (including a single-provider run), revisions are skipped. A failed revision leaves its original draft available to synthesis. If every synthesizer fails, a revised answer is preferred for the explicitly labeled single-model fallback. Original answers, critiques, and revisions remain available in local history and Markdown exports.

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

The app uses React, TypeScript, Vinext, and Cloudflare Workers. The POST /api/ask endpoint streams stage updates and visible answer text as newline-delimited JSON. Provider calls happen server-side to fixed vendor endpoints; API keys are never sent to another vendor, logged, or saved by the app. Production access is controlled by the private Sites deployment.

Live drafts, reviews, revisions, and synthesis stream as they are written. The workspace initially shows Perspectives and switches to Answer when synthesis starts. A broken stream retries once without streaming, clearing its previous partial text. Partial output never enters peer-review prompts or saved turns. Stop cancels provider reads and preserves completed questions; the interrupted contribution remains visible only in the current tab.

The hosted event contract adds `contribution_start` and `contribution_delta` with a `provider` and `phase` (`research`, `draft`, `review`, `revision`, or `synthesis`). Start clears that contribution; delta appends visible text. Existing complete `draft`, `review`, `revision`, and `final` events remain authoritative. `lib/run-events.ts` handles client state separately from the Python SSE contract. Provider parsers require a terminal completion event and ignore thought/tool content. See the official [OpenAI Responses](https://developers.openai.com/api/docs/guides/streaming-responses), [Claude Messages](https://platform.claude.com/docs/en/build-with-claude/streaming), and [Gemini Interactions](https://ai.google.dev/gemini-api/docs/streaming) streaming specifications.

## Shared web research

Turn on **Web research** in Live mode. Choose OpenAI, Claude, or Automatic (OpenAI when connected, otherwise Claude). It requires an enabled connection and a model/account supporting the [OpenAI Responses web-search tool](https://developers.openai.com/api/docs/guides/tools-web-search) or [Claude basic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool). The chosen provider searches first; the same cited brief, source URLs, and timestamp then go to every draft, review, revision, and synthesis call. The other steps have no browsing tools. The brief is evidence to evaluate, not independent verification by three search engines.

Research adds one response, plus at most one OpenAI stream retry or one Claude paused-turn continuation. OpenAI allows at most three built-in tool calls per request; Claude allows at most three searches per request (up to six across a paused-turn continuation). Automatic selection chooses a connected provider before calling; it does not move a failed search to another provider. Search and token charges apply; the UI reports usage but omits research cost estimates. It is off by default and disabled in demo mode. Search failures or a response without completed search and usable citations produce a visible warning, then normal collaboration continues with an explicit unavailable-research notice in model context.

Citations come from provider metadata, not URLs guessed from prose. The research panel shows clickable inline references and a source list; only HTTP(S) URLs without embedded credentials are accepted. Briefs and citations survive opt-in local history and Markdown exports. Research text is displayed only after its complete citation metadata arrives. Claude research uses complete JSON responses so its native citation blocks and any paused assistant content are available together. A `pause_turn` response is sent back unchanged only to Anthropic; encrypted tool-result data never enters another provider’s prompt or saved history. A second pause ends research with an explicit unavailable-brief notice. The `research` event carries the completed brief and its provider attribution; partial research text is never shared or saved. Follow-ups search again only while the toggle is on. No search results are fabricated in demo mode.

Google Search grounding is not used as a shared research source: its [grounding terms](https://ai.google.dev/gemini-api/terms#grounding-with-google-search) restrict analysis, modification, and reuse of grounded results in ways that do not fit this cross-provider review pipeline. Gemini can participate in every collaboration stage using the shared OpenAI or Claude brief.

## Portable session backups

Use **Back up & restore** in the sidebar to download a versioned Trio JSON file or preview one from another device. Backups include complete questions, answers, all model contributions, citations, and usage. API connection settings and original attachment bytes are stripped; conversations themselves may contain private information, so keep the file private. Markdown exports remain available for reading and sharing.

Import validates every record before making changes, then lets you select conversations. Identical content is skipped, even if another device assigned it a different ID. Changed versions with matching IDs are kept as separate copies. Existing sessions, the active conversation, and an unsent prompt remain intact. An import that would exceed the 30-session limit is blocked until fewer conversations are selected; it never silently evicts existing history.

Backups may be up to 20 MB and can recover conversations larger than the 5-million-character local-history limit. The preview warns when imported sessions cannot fit local history. Import does not enable persistence or make any model requests. With local history off, imported sessions remain in tab memory until you enable it in Connections; storage failures retain the existing warning and export controls. Corrupt files and unsupported backup versions are rejected as a whole. The file is parsed locally and never uploaded by the restore workflow.

## Data and limits

- Prompts, attached text and images, and recent live conversation context are sent to enabled providers. Drafts and reviews are shared among participating providers. Image bytes use each provider's native image part, never a base64 string embedded in text prompts. Only local uploads are accepted; the app does not fetch arbitrary image URLs.
- Keys live in browser memory and in server request memory while a run is active. Reloading clears them.
- Sessions live in browser memory unless you explicitly enable local history. Local history is device-specific, includes prompts and answers, and does not include API keys or the original attachments (answers may quote them). Refresh restores the active session after validating saved records. Clear history with the sidebar trash button and confirmation.
- Each follow-up includes at most six recent live question/answer pairs, including the model perspectives from Compare runs; demo content is excluded. Prior answers are capped at 30,000 characters per turn.
- Each question is limited to 20,000 characters; attached text to 60,000 characters; image bytes to 4 MB. Total request bodies are limited to 8 MB, including base64 encoding and conversation context. Browser uploads check decoding and dimensions; the endpoint checks base64 size, type, and file signature. Provider timeouts are 120 seconds per call.
- Three connected models normally use ten calls in Deep Council, seven in Council, four in Quick synthesis, or three in Compare. Synthesis can try up to two alternate models. Each broken streaming call can add one non-streaming retry, including failover attempts. Retries can incur extra charges; attempted calls and incomplete usage are reported. Each vendor bills its own usage.
- Live results include a usage panel with attempted calls, reported input/output tokens, and a per-model breakdown. Missing provider metadata and failed requests are explicitly marked as partial usage. Gemini thinking tokens count as output; OpenAI reasoning tokens are already included in its output total. Usage is included in local history and Markdown exports.
- Standard-rate USD estimates are shown only when every attempt reported usage and all models have a known, unexpired uncached rate. They exclude discounts and taxes. Cached usage, unknown models, missing metadata, and expired rates display no cost estimate; provider invoices remain authoritative. Current rates were checked September 22, 2026 against [OpenAI](https://developers.openai.com/api/docs/models/gpt-6-astra), [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing), and [Google](https://ai.google.dev/gemini-api/docs/pricing). The table expires January 1, 2027, before using outdated introductory rates.
- A failed provider does not stop the others. If all synthesis attempts fail, an independent draft is explicitly labeled as a fallback.
- Text, code, and image understanding are supported. Optional web research uses OpenAI or Claude to share a cited brief with all participants. This version does not execute code, generate images, or expose every feature of the vendors' consumer apps. Custom models must support image inputs. Vision request formats follow the official [OpenAI](https://developers.openai.com/api/docs/guides/images-vision), [Claude](https://platform.claude.com/docs/en/build-with-claude/vision), and [Gemini](https://ai.google.dev/gemini-api/docs/image-understanding) documentation. Image runs report provider token usage but omit cost estimates because modality-specific pricing has not been verified.
- Model agreement is not verification. Important claims and decisions still need checking.

## Validation

Deterministic tests cover the pipeline, critique-driven revisions, cancellation, provider failures, synthesis failover, shared context, comparison, no-key rejection, error-message redaction, saved-record validation, exports, vendor usage normalization, partial totals, cache handling, and price expiration. Browser tests cover desktop/mobile layout, the demo, tabs, connection controls, key non-persistence, history restoration, request validation, Markdown safety, code copying, attachment isolation, and usage details.

Run browser checks with Playwright installed separately and a local dev server running:

```sh
node tests/browser-smoke.mjs
node tests/browser-quality.mjs
node tests/browser-deep-council.mjs
node tests/browser-history.mjs
node tests/browser-storage.mjs
node tests/browser-streaming.mjs
node tests/browser-images.mjs
node tests/browser-research.mjs
node tests/browser-claude-research.mjs
node tests/browser-backups.mjs
```

The scripts default to Microsoft Edge and http://localhost:5173. Set TRIO_BASE_URL to test a server on another port, PLAYWRIGHT_CHANNEL for another installed Chromium channel, and optionally PLAYWRIGHT_MODULE to a module URL if using a bundled Playwright installation.

Real paid API calls have not been verified without user-provided keys. Model availability depends on each account; model IDs are editable in Connections.

## API references

- [OpenAI Responses API](https://developers.openai.com/api/docs/quickstart)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Gemini Interactions API](https://ai.google.dev/gemini-api/docs/get-started)

## Hosting

The .openai/hosting.json manifest identifies this private Sites app. Keep its project ID when updating this deployment. The production build is packaged from dist/ and deployed with the Sites publishing workflow. Sharing changes are separate from publishing.
