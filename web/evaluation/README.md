# Live quality evaluation

This opt-in developer tool runs Trio's real hosted orchestrator against six synthetic cases with locally known answers. It compares separate individual-model samples (`compare`) with a subsequent Quick synthesis, Council, or Deep Council run. It does not read account conversations, personal memory, browser API keys, or site data.

The cases check unit arithmetic, a false numerical premise, acknowledging missing evidence, ignoring instructions embedded in reference text, and two order-swapped presentations of equal evidence. Exact JSON values are scored locally. There is no model acting as a judge, and model agreement is not a scoring criterion. A JSON formatting failure is reported separately from an incorrect value.

## Preview without charges

Run from `web/` with Node 24:

```sh
pnpm eval:quality
pnpm eval:quality --providers openai --cases units --max-calls 3
pnpm eval:quality --help
```

These commands make no API requests and write no reports. The preview shows model IDs, whether selected credentials are present, case IDs, nominal calls, the hard call limit, and deadline. The default six-case, three-provider Council comparison normally uses 60 HTTP calls before retries or failover. Its default hard limit is also 60, so retries may leave later cases unrun. The call limit counts HTTP attempts, not money or tokens; providers bill separately.

## Explicit live execution

Configure only the provider credentials you intend to use in the process environment: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and/or `GEMINI_API_KEY`. Optional model overrides are `OPENAI_MODEL`, `CLAUDE_MODEL`, and `GEMINI_MODEL`; defaults match the app. No `.env` file is loaded automatically. Do not put credentials in command arguments, report filenames, Git, or chat.

After reviewing the preview, add `--run` to make billed API requests:

```sh
pnpm eval:quality --run --providers openai --cases units --max-calls 3
pnpm eval:quality --run --providers openai,claude,gemini --mode council --max-calls 60
```

The first example checks a single provider with one independent answer followed by a draft and synthesis. It does not test peer collaboration. All selected providers must have credentials before any request is sent; the tool does not silently omit a missing connection. `--mode` accepts `fast`, `council`, or `deep`. `--cases` accepts the comma-separated IDs shown in the preview. `--max-calls` accepts 1–500, and `--timeout-seconds` accepts 1–3600 (default 900). No web research or paid search tools are enabled.

The orchestrator's existing retries and synthesis failover share the same call budget. There are no additional case-level retries. Ctrl+C requests cancellation and a partial report. A deadline or exhausted budget leaves unattempted results explicitly `not_run`. A transport failure or single-model fallback is marked degraded even when its answer happens to be correct.

## Reports and interpretation

Reports default to the Git-ignored `test-output/quality-<timestamp>-<id>.json`. `--output PATH` selects a different **new** file. The file is reserved before any billed requests; an existing/unwritable path fails before networking. Abrupt process termination can leave the reserved file empty, which is not a completed report.

Reports record run timestamps, the source commit/dirty state when Git is available, model IDs, per-case individual/team verdicts, phase completion/degradation, actual HTTP counts, and reported token/cost metadata. `calls` and per-phase `httpCalls` are actual network attempts. Provider usage counters may include attempts blocked by the evaluation budget, and failed/interrupted calls may have unreported charges; invoices remain authoritative.

By default, raw model text is excluded; parsed answer values remain available for diagnosis. Use `--include-answers` to retain the synthetic-case responses. Known configured API keys are redacted from report strings. Reports should still be reviewed before sharing. The console shows the plan, summary, and report path; raw provider diagnostics are not printed.

Exit codes: **0** for a preview or a completed run where every individual/team verdict passed without a degraded phase; **1** for a completed run with failed checks or degraded phases; **2** for configuration errors, incomplete/cancelled/timed-out runs, or report-writing failure.

This is a small regression suite, not an estimate of general accuracy or proof that a model is unbiased. Models and draft ordering are nondeterministic; the independent and team runs are separate samples. Inspect per-case outputs, repeat trials when appropriate, and use representative domain cases and human review before drawing broader conclusions. Passing the offline tests proves the evaluator's mechanics, not the live models' quality.

## Offline validation

`pnpm test` covers exact scoring, all 60 simulated calls, wrong individual versus correct team answers, budget exhaustion, actual provider retry accounting, fallback labeling, missing credentials, cancellation with preserved completed drafts, deadlines, redaction, CLI preview without networking, file preflight, and a fully simulated CLI report. No real API keys or paid calls are needed for these tests.
