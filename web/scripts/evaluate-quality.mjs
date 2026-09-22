import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { evaluationConfig } from '../evaluation/config.ts';
import { evaluateQuality, redactReport } from '../evaluation/runner.ts';

const help = `Trio live quality evaluation (Node 24)
Default: preview only; no API requests and no report file.
  --run                    Explicitly make billed provider API calls
  --providers LIST         openai,claude,gemini (default: all three)
  --mode MODE              fast, council (default), or deep
  --cases LIST             Comma-separated IDs from the preview
  --max-calls N            Maximum HTTP attempts, including retries (1–500; default 60)
  --timeout-seconds N      Overall deadline (1–3600; default 900)
  --output PATH            New JSON report file (never overwrites an existing file)
  --include-answers        Include synthetic-case model text in the report
Environment: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY.
Optional: OPENAI_MODEL, CLAUDE_MODEL, GEMINI_MODEL. No .env is loaded automatically.
Reports default to ignored test-output/quality-<timestamp>-<id>.json.
Exit: 0 preview/all checks pass; 1 completed evaluation with failures/degraded phases;
2 configuration, interrupted/incomplete run, or report-writing failure.
A small synthetic suite cannot establish general accuracy or absence of bias.`;

try {
  const config = evaluationConfig(process.argv.slice(2), process.env);
  if (config.help) console.log(help);
  else {
    console.log(JSON.stringify(redactReport(config.preview, config.connections), null, 2));
    if (config.run) {
      if (Object.values(config.connections).some(c => c.enabled && !c.key.trim())) throw new Error('Missing selected credentials.');
      let source = { commit: null, dirty: null };
      try { source = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) }; } catch {}
      const path = resolve(config.output ?? `test-output/quality-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
      await mkdir(dirname(path), { recursive: true });
      // Reserve a new writable file before making any billed requests.
      const output = await open(path, 'wx');
      const stop = new AbortController(), cancel = () => stop.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      let report;
      try {
        report = await evaluateQuality(config.connections, config.options, stop.signal);
        await output.writeFile(JSON.stringify({ ...report, source }, null, 2) + '\n');
      } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); await output.close(); }
      console.log(JSON.stringify(redactReport({ status: report.status, calls: report.calls, summary: report.summary, report: path }, config.connections), null, 2));
      process.exitCode = report.status !== 'complete' ? 2 : report.summary.degradedPhases || report.results.some(r => r.team.status !== 'pass' || Object.values(r.baseline).some(v => v.status !== 'pass')) ? 1 : 0;
    }
  }
} catch {
  console.error('Evaluation could not complete. Check --help, selected provider credentials, limits, and a new writable report path. No raw provider diagnostics are printed.');
  process.exitCode = 2;
}
