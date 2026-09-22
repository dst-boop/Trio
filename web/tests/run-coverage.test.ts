import test from 'node:test';
import assert from 'node:assert/strict';
import { runCoverage, answerLabel, coverageMarkdown } from '../lib/run-coverage.ts';
import { sessionMarkdown, parseSessions, serializeSessions } from '../lib/sessions.ts';
import type { Result, Mode, Phase } from '../lib/trio.ts';

const base: Result = { drafts: { openai:'Draft A',claude:'Draft B',gemini:'Draft C' }, reviews: { openai:'Review A',claude:'Review B',gemini:'Review C' }, answer:'Final answer', by:'claude', errors:[], seconds:1, demo:false };
const state = (result: Result, phase: Phase, mode: Mode = 'council') => runCoverage(result,mode).find(s=>s.phase===phase)!;

test('coverage distinguishes full, partial, failed, and skipped peer review', () => {
  assert.equal(state(base,'review').state,'complete');
  const partial={...base,reviews:{claude:'Review B'}}; assert.equal(state(partial,'review').state,'partial');assert.match(state(partial,'review').detail,/1 of 3/);
  assert.equal(state({...base,reviews:{}},'review').state,'unavailable');
  const single={...base,drafts:{claude:'Draft'},reviews:{}};assert.equal(state(single,'review').state,'skipped');assert.match(state(single,'draft').detail,/No cross-model comparison/);assert.equal(answerLabel(single),'Single-model answer');
  assert.equal(state({...base,reviews:{}},'review','fast').state,'skipped');
  assert.equal(state({...base,reviews:{}},'review','compare').state,'skipped');
});

test('Deep Council revisions and synthesis fallbacks cannot appear fully completed', () => {
  assert.equal(state({...base,revisions:{openai:'Revision A'}},'revision','deep').state,'partial');
  assert.equal(state(base,'revision','deep').state,'unavailable');
  assert.equal(state({...base,reviews:{}},'revision','deep').state,'skipped');
  const fallback={...base,fallback:true};assert.equal(state(fallback,'synthesis').state,'unavailable');assert.equal(answerLabel(fallback),'Single-model fallback');assert.match(state(fallback,'synthesis').detail,/draft or revision/);
  assert.equal(state({...base,answer:''},'synthesis','compare').state,'skipped');
  assert.equal(state({...base,answer:''},'synthesis').state,'unavailable');
});

test('web evidence never claims independent verification, including failed research and demo', () => {
  assert.equal(state(base,'research').state,'skipped');assert.match(state(base,'research').detail,/did not browse/);
  assert.equal(state({...base,researchRequested:true},'research').state,'unavailable');
  const researched={...base,researchRequested:true,research:{provider:'claude' as const,text:'Cited brief',at:'2026-09-22T00:00:00Z',sources:[{url:'https://example.com/source',title:'Source'}]}};
  assert.equal(state(researched,'research').state,'complete');assert.match(state(researched,'research').detail,/1 source.*not been independently verified/);
  const demo={...researched,demo:true};assert.ok(runCoverage(demo,'deep').every(s=>s.state==='sample'));assert.equal(coverageMarkdown(demo,'deep'),'');assert.equal(answerLabel(demo),'Sample answer');
});

test('saved results and Markdown retain partial review coverage without changing the storage format', () => {
  const result={...base,reviews:{claude:'One review'},researchRequested:true,fallback:true};
  const session={id:'coverage',title:'Question',time:'',turns:[{question:'Question',mode:'council' as const,result}]};
  const restored=parseSessions(serializeSessions([session]))[0];assert.deepEqual(runCoverage(restored.turns[0].result,'council'),runCoverage(result,'council'));
  const markdown=sessionMarkdown(restored.turns);assert.match(markdown,/Peer review — Partial: 1 of 3/);assert.match(markdown,/Web research — Unavailable/);assert.match(markdown,/Write answer — Unavailable/);assert.match(markdown,/do not prove accuracy/);assert.match(markdown,/## Single-model fallback/);
});
