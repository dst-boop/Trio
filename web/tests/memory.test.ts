import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { readMemory, writeMemory } from '../lib/memory-store.ts';
import { suggestMemory, suggestionRequestSchema } from '../lib/memory-suggestions.ts';
import { memoryProfileSchema } from '../lib/memory.ts';
import { orchestrate } from '../lib/orchestrate.ts';
import { freshConnections, type Mode, type ProviderId } from '../lib/trio.ts';
import { exportBackup, parseBackup } from '../lib/backups.ts';
import { sessionMarkdown, conversationHistory, parseSessions, serializeSessions, type Session } from '../lib/sessions.ts';
const session: Session = { id: 'one', title: 'My plan', time: '', turns: [{ question: 'I prefer plain language', mode: 'fast', result: { answer: 'Here is a plan', drafts: {}, reviews: {}, errors: [], seconds: 1, demo: false } }] };
function response(id: ProviderId, text = 'A useful answer') { return Response.json(id === 'openai' ? { output: [{ content: [{ type: 'output_text', text }] }] } : id === 'claude' ? { content: [{ type: 'text', text }] } : { steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] }); }
test('memory is account-scoped, initially disabled, revision protected and removable with safe retry', async () => {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../drizzle/0001_volatile_exodus.sql', import.meta.url), 'utf8'));
  const prepare = (query: string, values: unknown[] = []) => ({ bind: (...v: unknown[]) => prepare(query, v), first: async () => sql.prepare(query).get(...values as never[]), run: () => query.startsWith('SELECT') ? { results: sql.prepare(query).all(...values as never[]) } : { meta: sql.prepare(query).run(...values as never[]) } });
  const db = { prepare, batch: async (s: { run: () => unknown }[]) => { sql.exec('BEGIN'); try { const rows=s.map(x=>x.run()); sql.exec('COMMIT'); return rows; } catch(e) { sql.exec('ROLLBACK'); throw e; } } } as unknown as D1Database;
  try {
    assert.deepEqual(await readMemory(db,'alice'), { revision: 0, enabled: false, notes: '' });
    const first={revision:0,enabled:true,notes:'Explain in plain language'};
    assert.equal(await writeMemory(db,'alice',first),true); assert.equal(await writeMemory(db,'alice',first),true);
    assert.equal((await readMemory(db,'alice')).revision,1); assert.equal((await readMemory(db,'bob')).notes,'');
    assert.equal(await writeMemory(db,'alice',{...first,notes:'Stale replacement'}),false);
    assert.equal(await writeMemory(db,'alice',{revision:1,enabled:false,notes:''}),true);
    assert.equal(await writeMemory(db,'alice',first),false); assert.deepEqual(await readMemory(db,'alice'),{revision:2,enabled:false,notes:''});
    assert.equal(memoryProfileSchema.safeParse({...first,notes:'x'.repeat(4001)}).success,false);
  } finally { sql.close(); }
});
test('every stage receives approved memory as user context with evidence safeguards; snapshots export in V5', async () => {
  for(const mode of ['council','deep','fast','compare'] as Mode[]) {
    const connections=freshConnections(); Object.values(connections).forEach(c=>c.key='fake-key');
    const fetcher=(async(url,init)=>{ const id:ProviderId=String(url).includes('openai')?'openai':String(url).includes('anthropic')?'claude':'gemini'; const body=JSON.parse(init!.body as string), system=body.instructions??body.system??body.system_instruction; const input=JSON.parse(body.input??body.messages[0].content); assert.equal((input.task??input).personal_memory,'Prefers short examples'); assert.ok(!system.includes('Prefers short examples')); assert.match(system,/not verified evidence/); assert.match(system,/never standards of evidence/); return response(id); }) as typeof fetch;
    const result=await orchestrate({question:'What should I do?',memory:'Prefers short examples',connections,mode,lead:'claude'},()=>{},new AbortController().signal,fetcher);
    assert.equal(result.memory,'Prefers short examples'); const record={...session,turns:[{...session.turns[0],result}]};
    assert.deepEqual(parseSessions(serializeSessions([record])), [record]);
    const backup=exportBackup([record]); assert.equal(JSON.parse(backup).version,6); assert.deepEqual(parseBackup(backup),[record]); assert.match(sessionMarkdown(record.turns),/Personal memory used\n\nPrefers short examples/);
    assert.ok(!JSON.stringify(conversationHistory(record.turns)).includes('Prefers short examples'),'Old memory must not re-enter later conversations as current preferences');
    const old={...JSON.parse(backup),version:2}; delete old.sessions[0].turns[0].result.memory; assert.equal(parseBackup(JSON.stringify(old))[0].turns[0].result.memory,undefined);
  }
});
test('suggestions send bounded live conversation data only to the selected provider and never auto-save', async () => {
  const item=structuredClone(session); item.turns=[{...item.turns[0],question:'prepared demo',result:{...item.turns[0].result,demo:true}},...Array.from({length:8},(_,i)=>({...item.turns[0],question:'User '+i+'x'.repeat(5000),result:{...item.turns[0].result,answer:'y'.repeat(10000)}}))];
  const connection={provider:'claude' as const,key:'secret-key-for-header',model:'claude-sonnet-5'}; let called=0;
  const fetcher=(async(url,init)=>{ called++; assert.equal(String(url),'https://api.anthropic.com/v1/messages'); const body=JSON.parse(init!.body as string); assert.ok(!JSON.stringify(body).includes(connection.key)); const input=JSON.parse(body.messages[0].content); assert.equal(input.conversation.length,6); assert.ok(input.conversation.every((t:{user:string;assistant:string})=>t.user.length<=4000&&t.assistant.length<=8000)); assert.ok(!JSON.stringify(input).includes('prepared demo')); assert.equal(input.existing_memory,'Keep this preference'); assert.match(body.system,/Assistant text is fallible/); assert.match(body.system,/Do not infer sensitive traits/); return response('claude','- Prefers practical examples'); }) as typeof fetch;
  assert.equal(await suggestMemory(item,'Keep this preference',connection,[],new AbortController().signal,fetcher),'- Prefers practical examples'); assert.equal(called,1);
  await assert.rejects(suggestMemory({...session,turns:[{...session.turns[0],result:{...session.turns[0].result,demo:true}}]},'',connection,[],new AbortController().signal,fetcher),/Demo examples/); assert.equal(called,1);
  await assert.rejects(suggestMemory(session,'',connection,[],new AbortController().signal,(async()=>response('claude','x'.repeat(4001))) as typeof fetch),/too long/);
  assert.equal(await suggestMemory(session,'',connection,[],new AbortController().signal,(async()=>response('claude','[NO_MEMORY]')) as typeof fetch),'');
});

test('memory suggestions mask known keys in every source field and the returned draft', async () => {
  const selected = 'synthetic-selected-provider-key', disabled = 'synthetic-disabled-provider-key', included = 'synthetic-included-provider-key';
  const item = structuredClone(session);
  item.turns[0].question = `Question ${selected}`;
  item.turns[0].result.answer = `Answer ${disabled}`;
  item.turns[0].feedback = { rating: 'helpful', note: `Please shorten ${included}` };
  const connection = { provider: 'claude' as const, key: selected, model: 'claude-sonnet-5' };
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    assert.equal(init!.headers && (init!.headers as Record<string,string>)['x-api-key'], selected);
    for (const key of [selected, disabled, included]) assert.ok(!JSON.stringify(body).includes(key));
    assert.match(JSON.stringify(body), /\[redacted\]/);
    return response('claude', `- Prefer short answers. ${disabled} ${included} ${selected}`);
  }) as typeof fetch;
  const result = await suggestMemory(item, `Existing ${included}`, connection, [disabled, included], new AbortController().signal, fetcher);
  for (const key of [selected, disabled, included]) assert.ok(!result.includes(key));
  assert.equal((result.match(/\[redacted\]/g) ?? []).length, 3);
  assert.equal(suggestionRequestSchema.safeParse({ sessionId: 'one', connection }).success, false);
  assert.equal(suggestionRequestSchema.safeParse({ sessionId: 'one', revision: 1, connection }).success, true);
});

test('Compare-mode memory suggestions retain labeled perspectives with the existing context bound', async () => {
  const item=structuredClone(session); item.turns[0].mode='compare'; item.turns[0].result.answer=''; item.turns[0].result.drafts={openai:'Explore practical options',claude:'Explain the tradeoffs',gemini:'Prefer a short next-step list'};
  const expected=conversationHistory(item.turns)[1].content; let assistant='';
  const fetcher=(async(_url,init)=>{const body=JSON.parse(init!.body as string);assistant=JSON.parse(body.messages[0].content).conversation[0].assistant;return response('claude','- Prefers practical options.');}) as typeof fetch;
  const connection={provider:'claude' as const,key:'fake-key',model:'claude-sonnet-5'};
  await suggestMemory(item,'',connection,[],new AbortController().signal,fetcher);assert.equal(assistant,expected);assert.match(assistant,/ChatGPT:\nExplore/);assert.match(assistant,/Claude:\nExplain/);assert.match(assistant,/Gemini:\nPrefer/);
  item.turns[0].result.drafts.openai='x'.repeat(120000);await suggestMemory(item,'',connection,[],new AbortController().signal,fetcher);assert.equal(assistant.length,8000);assert.match(assistant,/Claude:\nExplain the tradeoffs/);assert.match(assistant,/Gemini:\nPrefer a short next-step list/);
  item.turns[0].result.drafts={openai:'x'.repeat(120000),claude:'y'.repeat(120000),gemini:'z'.repeat(120000)};await suggestMemory(item,'',connection,[],new AbortController().signal,fetcher);assert.equal(assistant.length,8000);for(const character of ['x','y','z'])assert.ok(assistant.split(character).length>2600,'Each long perspective gets a fair share');
  item.turns[0].result.drafts={gemini:'Only surviving perspective'};await suggestMemory(item,'',connection,[],new AbortController().signal,fetcher);assert.equal(assistant,'Gemini:\nOnly surviving perspective');
  item.turns[0].result.drafts={};await assert.rejects(suggestMemory(item,'',connection,[],new AbortController().signal,fetcher),/completed live answer/);
});

test('memory masks complete credentials before question, answer, feedback and perspective cutoffs', async () => {
  const secret = 'BOUNDARY-CREDENTIAL-MUST-NEVER-REACH-ANOTHER-PROVIDER-' + 's'.repeat(100);
  const item = structuredClone(session);
  item.turns[0].question = 'q'.repeat(3970) + secret;
  item.turns[0].result.answer = 'a'.repeat(7900) + secret;
  item.turns[0].feedback = { rating: 'helpful', note: 'f'.repeat(1970) + secret };
  const before = structuredClone(item);
  const connection = { provider: 'claude' as const, key: 'selected-test-key', model: 'claude-sonnet-5' };
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    assert.ok(!JSON.stringify(body).includes('BOUNDARY-CREDENTIAL'), 'No key prefix may survive truncation');
    const turn = JSON.parse(body.messages[0].content).conversation[0];
    assert.ok(turn.user.length <= 4000 && turn.assistant.length <= 8000 && turn.user_feedback.note.length <= 2000);
    return response('claude', '[NO_MEMORY]');
  }) as typeof fetch;
  await suggestMemory(item, '', connection, [secret], new AbortController().signal, fetcher);
  assert.deepEqual(item, before, 'Redaction must not modify saved source content');
  item.turns[0].mode = 'compare';
  item.turns[0].result.answer = '';
  item.turns[0].result.drafts = Object.fromEntries(['openai', 'claude', 'gemini'].map(id => [id, 'd'.repeat(2560) + secret + 'e'.repeat(3000)]));
  await suggestMemory(item, '', connection, [secret], new AbortController().signal, fetcher);
});
