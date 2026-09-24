import { z } from 'zod';
import { qualityCases } from './cases.ts';
import { representativeCases } from './representative-cases.ts';
import { estimateStandardCost } from '../lib/usage.ts';
import type { ProviderId } from '../lib/trio.ts';

export const qualitySettings = z.object({
  suite: z.enum(['core', 'representative', 'all']).default('core'),
  mode: z.enum(['fast', 'council', 'deep']).default('council'),
  baseline: z.enum(['openai', 'claude', 'gemini']).default('claude'),
  providers: z.array(z.enum(['openai', 'claude', 'gemini'])).min(2).max(3).refine(p => new Set(p).size === p.length),
  maxCalls: z.number().int().min(1).max(500).default(60),
  timeoutSeconds: z.number().int().min(1).max(3600).default(900),
}).strict().refine(s => s.providers.includes(s.baseline), 'The comparison baseline must participate.');
export type QualitySettings = z.infer<typeof qualitySettings>;
export const defaultQualitySettings: QualitySettings = {suite:'core',mode:'council',baseline:'claude',providers:['openai','claude','gemini'],maxCalls:60,timeoutSeconds:900};
export const suiteCases = (suite: QualitySettings['suite']) => suite === 'core' ? qualityCases : suite === 'representative' ? representativeCases : [...qualityCases, ...representativeCases];
export function qualityEstimate(settings: QualitySettings, models: Partial<Record<ProviderId, string>>) {
  const count = suiteCases(settings.suite).length;
  const rounds = settings.mode === 'fast' ? 2 : settings.mode === 'deep' ? 4 : 3;
  const nominalCalls = count * (settings.providers.length * rounds + 1);
  // An illustrative token allowance, not a quote or spending cap. The runtime
  // uses the existing dated price table and refuses unknown/expired rates.
  let illustrativeUSD: number | null = 0;
  for (const provider of settings.providers) {
    const calls = count * (rounds + Number(provider === (settings.providers.includes('claude') ? 'claude' : settings.providers[0])));
    const cost = estimateStandardCost(models[provider] ?? '', {input:2000, output:1000, cached:0});
    if (cost === null) { illustrativeUSD = null; break; }
    illustrativeUSD += calls * cost;
  }
  return {caseCount:count, nominalCalls, illustrativeUSD};
}
