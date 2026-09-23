import { freshConnections, providers, type ProviderId } from '../lib/trio.ts';
import { qualityCases } from './cases.ts';
import { representativeCases } from './representative-cases.ts';
const allCases = [...qualityCases, ...representativeCases];
import type { EvaluationOptions } from './runner.ts';

export function evaluationConfig(args: string[], env: Record<string, string | undefined>) {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--run', '--help', '--include-answers', '--providers', '--mode', '--cases', '--max-calls', '--timeout-seconds', '--output', '--suite', '--baseline'].includes(flag) || flags.has(flag)) throw new Error('Unknown or repeated evaluation option. Use --help.');
    if (['--run', '--help', '--include-answers'].includes(flag)) flags.set(flag, 'true');
    else { const value = args[++i]; if (!value || value.startsWith('--')) throw new Error('An evaluation option is missing its value. Use --help.'); flags.set(flag, value); }
  }
  const chosen = (flags.get('--providers') ?? 'openai,claude,gemini').split(',');
  if (!chosen.length || new Set(chosen).size !== chosen.length || chosen.some(id => !providers.some(p => p.id === id))) throw new Error('Select distinct providers from openai,claude,gemini.');
  const suite = flags.get('--suite') ?? 'core';
  if (!['core', 'representative', 'all'].includes(suite)) throw new Error('Suite must be core, representative, or all.');
  const defaults = suite === 'core' ? qualityCases : suite === 'representative' ? representativeCases : allCases;
  const baseline = flags.get('--baseline') ?? (chosen.includes('claude') ? 'claude' : chosen[0]);
  if (!chosen.includes(baseline)) throw new Error('The fixed baseline must be a selected provider.');
  const ids = flags.get('--cases')?.split(',') ?? defaults.map(c => c.id);
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !allCases.some(c => c.id === id))) throw new Error('Select distinct case IDs shown in the preview.');
  const mode = flags.get('--mode') ?? 'council';
  if (!['fast', 'council', 'deep'].includes(mode)) throw new Error('Evaluation mode must be fast, council, or deep.');
  const number = (flag: string, fallback: number, max: number) => { const value = flags.get(flag) ?? String(fallback); if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error('Evaluation limits must be positive integers within the documented bounds.'); return Number(value); };
  const options: EvaluationOptions = { baseline: baseline as ProviderId, mode: mode as EvaluationOptions['mode'], maxCalls: number('--max-calls', 60, 500), timeoutSeconds: number('--timeout-seconds', 900, 3600), includeAnswers: flags.has('--include-answers'), cases: ids.map(id => allCases.find(c => c.id === id)!) };
  const connections = freshConnections();
  const keyNames = { openai: 'OPENAI_API_KEY', claude: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };
  const modelNames = { openai: 'OPENAI_MODEL', claude: 'CLAUDE_MODEL', gemini: 'GEMINI_MODEL' };
  for (const p of providers) {
    const c = connections[p.id]; c.enabled = chosen.includes(p.id); c.key = env[keyNames[p.id]]?.trim() ?? ''; c.model = env[modelNames[p.id]]?.trim() || p.model;
    if (c.key.length > 1024 || !/^[a-zA-Z0-9._:-]{1,100}$/.test(c.model)) throw new Error('An API key or model configuration is invalid. Check the environment variables.');
  }
  const count = chosen.length, review = mode !== 'fast' && count > 1 ? count : 0, revision = mode === 'deep' ? review : 0;
  return { run: flags.has('--run'), help: flags.has('--help'), output: flags.get('--output'), connections, options,
    preview: { execution: flags.has('--run') ? 'live API calls requested' : 'preview only: no API calls', providers: chosen.map(id => ({ provider: id, model: connections[id as ProviderId].model, keyPresent: Boolean(connections[id as ProviderId].key) })), cases: options.cases!.map(c => ({ id: c.id, category: c.category })), mode, suite: flags.has('--cases') ? 'custom' : suite, baseline, nominalCalls: ids.length * (count + count + review + revision + 1), maxCalls: options.maxCalls, timeoutSeconds: options.timeoutSeconds, note: 'API providers bill separately. Retries and synthesis failover consume the shared call limit. This limit counts HTTP attempts, not dollars. Cases may remain unrun if the limit or deadline is reached.' } };
}
