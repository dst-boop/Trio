import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonTask, comparisonSettings, comparisonRatings, comparisonEstimate, comparisonSamples, defaultComparisonSettings, blindComparisonText } from '../lib/work-comparison.ts';

test('work samples are explicitly fictional, bounded tasks with success criteria',()=>{
  assert.equal(comparisonSamples.length,3);
  for(const sample of comparisonSamples){assert.equal(sample.source,'sample');assert.deepEqual(comparisonTask.parse(sample),sample);assert.match(sample.title,/Fictional/);}
  assert.equal(comparisonTask.safeParse({...comparisonSamples[0],question:'   '}).success,false);
  assert.equal(comparisonTask.safeParse({...comparisonSamples[0],criteria:'ok'}).success,false);
  assert.equal(comparisonTask.safeParse({...comparisonSamples[0],context:'x'.repeat(8001)}).success,false);
});
test('comparison requires distinct providers and a participating final writer within fixed limits',()=>{
  assert.ok(comparisonSettings.safeParse(defaultComparisonSettings).success);
  for(const overrides of [{providers:['openai']},{providers:['openai','openai']},{providers:['claude','gemini'],baseline:'openai'},{maxCalls:31},{maxCalls:0},{timeoutSeconds:1801},{timeoutSeconds:29},{mode:'deep'},{timeZone:'Mars/Base'},{taskTime:'2000-01-01T00:00:00Z'}])assert.equal(comparisonSettings.safeParse({...defaultComparisonSettings,...overrides}).success,false);
});
test('nominal estimate includes just one independent baseline and the same chosen synthesis writer',()=>{
  const models={openai:'gpt-6-astra',claude:'claude-sonnet-5',gemini:'gemini-3.8-flash'};
  const estimate=comparisonEstimate(defaultComparisonSettings,models);
  assert.equal(estimate.nominalCalls,8);
  // Four OpenAI calls at .07, two Claude at .014, two Gemini at .00525.
  assert.ok(Math.abs(estimate.illustrativeUSD!-.3185)<1e-9);
  assert.equal(comparisonEstimate({...defaultComparisonSettings,providers:['openai','claude']},models).nominalCalls,6);
  assert.equal(comparisonEstimate(defaultComparisonSettings,{...models,claude:'unknown-model'}).illustrativeUSD,null);
});
test('blind presentation masks configured model IDs and labels without deleting ordinary company facts',()=>{
  const original='ChatGPT via gpt-6-astra, Claude, GEMINI, Anthropic and OpenAI. The task uses Google Drive.';
  assert.equal(blindComparisonText(original,{openai:'gpt-6-astra'}),'[model] via [model], [model], [model], [model] and [model]. The task uses Google Drive.');
  assert.match(original,/gpt-6-astra/,'Source text remains unchanged');
});
test('first human rating needs every dimension and an explicit preference; invalid scores cannot default to zero',()=>{
  const ratings={A:{useful:2,grounded:1,clear:0},B:{useful:1,grounded:2,clear:2},preference:'A',notes:'A captures the missing owner.'};
  assert.ok(comparisonRatings.safeParse(ratings).success);
  for(const overrides of [{A:{useful:2,clear:0}},{preference:''},{B:{useful:3,grounded:2,clear:2}},{notes:'x'.repeat(2001)},{measuredMinutesSaved:20}])assert.equal(comparisonRatings.safeParse({...ratings,...overrides}).success,false);
});
