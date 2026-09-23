import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { qualityCases } from '../evaluation/cases.ts';
import { representativeCases } from '../evaluation/representative-cases.ts';
import { evaluationConfig } from '../evaluation/config.ts';
import { evaluateQuality } from '../evaluation/runner.ts';
import { compareOutcomes } from '../evaluation/comparison.ts';
import { blindReview } from '../evaluation/blind.ts';
import { freshConnections, type ProviderId } from '../lib/trio.ts';

test('expanded suites are opt-in, retain the 60-call default cap, and fix baseline identity before running',()=>{
 const core=evaluationConfig([],{});assert.equal(core.options.cases?.length,6);assert.equal(core.preview.nominalCalls,60);
 const all=evaluationConfig(['--suite','all','--baseline','openai'],{});assert.equal(all.options.cases?.length,31);assert.equal(all.preview.nominalCalls,310);assert.equal(all.options.maxCalls,60);assert.equal(all.options.baseline,'openai');assert.equal(all.run,false);
 assert.equal(evaluationConfig(['--suite','representative'],{}).options.cases?.length,25);
 assert.equal(evaluationConfig(['--cases','compound-growth'],{}).options.cases?.[0].expected,17908);
 assert.throws(()=>evaluationConfig(['--providers','gemini','--baseline','claude'],{}),/selected provider/);
 assert.equal(new Set([...qualityCases,...representativeCases].map(c=>c.id)).size,31);
});
test('representative numeric fixtures have reproducible ground truth and complete reference rows',()=>{
 const expected=Object.fromEntries(representativeCases.map(c=>[c.id,c.expected]));
 assert.equal(expected['compound-growth'],Math.round(10000*1.06**10));
 assert.equal(expected['basis-points'],400000*75/10000);assert.equal(expected['refinance-breakeven'],4800/150);assert.equal(expected['rmd-divisor'],530000/26.5);
 assert.equal(expected['marginal-brackets'],20000*.1+40000*.2+20000*.3);assert.equal(expected['capital-gain'],120*(92.5-85));
 const n=expected['inflation-halving'] as number;assert.ok(.97**n<.5&&.97**(n-1)>=.5);
 assert.equal(expected['weighted-return'],100*(300000*.1+100000*.02)/400000);assert.equal(expected['base-rate'],Math.round(100*.001/(.001+.999*.05)));
 assert.equal(expected['anchoring-fee'],(270-250)/2);assert.ok(8/10>63/90&&45/90>4/10);
 for(const c of representativeCases.filter(c=>c.context))assert.ok(!c.context!.includes('\\n'),'Reference text contains no accidentally escaped newlines');
 for(const id of ['csv-filter-sum','latest-row-wins','false-premise-reference'])assert.ok(representativeCases.find(c=>c.id===id)!.context!.includes('\n'));
});
test('paired changes distinguish correctness from formatting and transport, with fixed and majority baselines',()=>{
 const pass={status:'pass' as const},wrong={status:'incorrect' as const};
 const rows=[{category:'math',baseline:{openai:pass,claude:pass,gemini:wrong},team:wrong,baselineRun:{degraded:false},teamRun:{degraded:false}},{category:'math',baseline:{openai:wrong,claude:wrong,gemini:pass},team:pass,baselineRun:{degraded:false},teamRun:{degraded:false}},{category:'format',baseline:{openai:pass,claude:pass,gemini:pass},team:{status:'format_error' as const},baselineRun:{degraded:false},teamRun:{degraded:false}},{category:'outage',baseline:{openai:pass,claude:pass,gemini:pass},team:wrong,baselineRun:{degraded:false},teamRun:{degraded:true}}];
 const r=compareOutcomes(rows,'openai',['openai','claude','gemini']);assert.equal(r.overall.eligible,2);assert.equal(r.overall.introducedErrors,1);assert.equal(r.overall.correctedErrors,1);assert.equal(r.overall.excluded,2);assert.equal(r.majority.introducedErrors,1);assert.equal(r.byCategory.math.eligible,2);
});
test('the real evaluator records separate baseline-provider timing and exports anonymous answers with a private key',async()=>{
 const c=freshConnections();Object.values(c).forEach(x=>x.key='synthetic-private-key');
 const item=representativeCases[0];
 const fetcher=(async(url:any)=>{
  const id:ProviderId=String(url).includes('anthropic')?'claude':String(url).includes('openai')?'openai':'gemini';
  const text=JSON.stringify({answer:item.expected});
  return Response.json(id==='openai'?{output:[{content:[{type:'output_text',text}]}]}:id==='claude'?{content:[{type:'text',text}]}:{steps:[{type:'model_output',content:[{type:'text',text}]}]});
 }) as typeof fetch;
 const r=await evaluateQuality(c,{mode:'fast',baseline:'openai',maxCalls:7,timeoutSeconds:20,cases:[item],includeAnswers:true},new AbortController().signal,fetcher);
 assert.equal(r.calls,7);assert.equal(r.version,2);assert.equal(r.baseline,'openai');assert.equal(r.comparison.overall.unchangedCorrect,1);
 assert.ok(r.results[0].baselineRun.elapsedMs!>=0);assert.equal(Object.keys(r.results[0].baselineRun.providerElapsedMs).length,3);
 assert.equal(Object.keys(r.results[0].teamRun.providerElapsedMs).length,0,'Do not mislabel team draft timings as standalone baselines');
 r.results[0].answers!.baseline.openai='OpenAI '+c.openai.model+' example';
 const b=blindReview(r);assert.equal(b.review.cases[0].answers.length,4);assert.equal(b.key.cases[0].expected,17908);assert.equal(Object.keys(b.key.cases[0].arms).length,4);
 assert.ok(!JSON.stringify(b.review).includes('OpenAI'));assert.ok(!JSON.stringify(b.review).includes(c.openai.model));assert.ok(!('expected' in b.review.cases[0]));assert.ok(!('models' in b.review));
 for(const a of b.review.cases[0].answers)assert.ok(b.key.cases[0].arms[a.label]);
 assert.throws(()=>blindReview({...r,results:r.results.map(x=>({...x,answers:undefined}))}));
});

test('offline blind-export CLI separates the key and never overwrites existing files',()=>{
 const dir=mkdtempSync(join(tmpdir(),'trio-blind-'));
 try {
  const source=join(dir,'source.json'),output=join(dir,'review.json');
  writeFileSync(source,JSON.stringify({version:2,mode:'council',baseline:'openai',models:{openai:'example-model',claude:'another-model'},results:[{id:'sample',question:'What is 2 + 2?',expected:4,answers:{baseline:{openai:'{"answer":4}',claude:'{"answer":5}'},team:'{"answer":4}'}}]}));
  const script=fileURLToPath(new URL('../scripts/blind-quality-report.mjs',import.meta.url));
  const run=()=>spawnSync(process.execPath,[script,source,output],{encoding:'utf8'});
  assert.equal(run().status,0);const publicText=readFileSync(output,'utf8');
  assert.equal(JSON.parse(publicText).cases[0].answers.length,3);assert.ok(!publicText.includes('example-model'));
  assert.equal(JSON.parse(readFileSync(output+'.key.json','utf8')).cases[0].expected,4);
  assert.equal(run().status,2);assert.equal(readFileSync(output,'utf8'),publicText);
 } finally {if(!resolve(dir).startsWith(resolve(tmpdir())+String.raw`\trio-blind-`)&&!resolve(dir).startsWith(resolve(tmpdir())+'/trio-blind-'))throw new Error('Unexpected test directory');rmSync(dir,{recursive:true,force:true});}
});
