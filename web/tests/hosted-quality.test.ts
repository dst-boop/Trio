import test from 'node:test';
import assert from 'node:assert/strict';
import {qualitySettings,defaultQualitySettings,qualityEstimate} from '../evaluation/hosted-config.ts';
import {evaluationConfig} from '../evaluation/config.ts';
import {evaluateQuality} from '../evaluation/runner.ts';
import {qualityCases} from '../evaluation/cases.ts';
import {freshConnections} from '../lib/trio.ts';

test('hosted default suite, baseline, mode and limits match the CLI; prices stay unknown for custom models',()=>{
 const cli=evaluationConfig([],{}),settings=qualitySettings.parse(defaultQualitySettings);
 assert.equal(settings.mode,cli.options.mode);assert.equal(settings.baseline,cli.options.baseline);assert.equal(settings.maxCalls,cli.options.maxCalls);assert.equal(settings.timeoutSeconds,cli.options.timeoutSeconds);
 assert.equal(qualityEstimate(settings,{}).nominalCalls,cli.preview.nominalCalls);assert.equal(qualityEstimate({...settings,suite:'all'},{}).nominalCalls,310);assert.equal(qualityEstimate(settings,{}).illustrativeUSD,null);
 assert.equal(qualitySettings.safeParse({...settings,maxCalls:501}).success,false);assert.equal(qualitySettings.safeParse({...settings,providers:['openai']}).success,false);
});
test('the same evaluator can run one baseline or team phase without silently running the other',async()=>{
 const connections=freshConnections();for(const c of Object.values(connections))c.key='synthetic-quality-secret';
 for(const phase of ['baseline','team'] as const){
  let calls=0;const fetcher=(async(url)=>{calls++;const text='{"answer":2050}';return Response.json(String(url).includes('openai')?{output:[{content:[{type:'output_text',text}]}]}:String(url).includes('anthropic')?{content:[{type:'text',text}]}:{steps:[{type:'model_output',content:[{type:'text',text}]}]});}) as typeof fetch;
  const report=await evaluateQuality(connections,{mode:'council',maxCalls:60,timeoutSeconds:30,cases:qualityCases.slice(0,1),phases:[phase]},new AbortController().signal,fetcher);
  assert.equal(calls,phase==='baseline'?3:7);assert.equal(report.results[0][phase==='baseline'?'teamRun':'baselineRun'].state,'not_run');
 }
});
