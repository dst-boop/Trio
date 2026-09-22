import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConnection } from '../lib/check-connection.ts';
import { connectionCheckSchema, connectionMessages } from '../lib/connection-status.ts';
import { providers } from '../lib/trio.ts';

test('access checks use only the selected vendor metadata endpoint and never generate text', async () => {
  for (const p of providers) {
    const result = await checkConnection({ provider: p.id, key: 'secret-for-'+p.id, model: p.model }, new AbortController().signal, (async (url, init) => {
      const host = p.id === 'openai' ? 'https://api.openai.com/v1/models/' : p.id === 'claude' ? 'https://api.anthropic.com/v1/models/' : 'https://generativelanguage.googleapis.com/v1beta/models/';
      assert.equal(String(url), host + p.model); assert.equal(init!.method, 'GET'); assert.equal(init!.body, undefined); assert.equal(init!.redirect, 'manual'); assert.equal(init!.cache, 'no-store');
      assert.deepEqual(init!.headers, p.id === 'openai' ? { Authorization: 'Bearer secret-for-openai' } : p.id === 'claude' ? { 'x-api-key': 'secret-for-claude', 'anthropic-version': '2023-06-01' } : { 'x-goog-api-key': 'secret-for-gemini' });
      return Response.json(p.id === 'openai' ? { object: 'model', id: p.model } : p.id === 'claude' ? { type: 'model', id: p.model+'-resolved' } : { name: 'models/'+p.model });
    }) as typeof fetch);
    assert.equal(result, 'checked');
  }
});
const input = { provider: 'openai', key: 'secret-key', model: 'gpt-6-astra' };
test('invalid credentials, paths, extra keys and oversized input never leave Trio', async () => {
  for (const bad of [{...input,key:''},{...input,key:'secret\r\ninjected'},{...input,key:'x'.repeat(1025)},{...input,model:'..'},{...input,model:'../messages'},{...input,model:'https://evil.test'},{...input,model:'x?key=secret'},{...input,provider:'other'},{...input,otherKey:'private'}]) {
    assert.equal(connectionCheckSchema.safeParse(bad).success,false);
    assert.equal(await checkConnection(bad,new AbortController().signal,(async()=>{assert.fail('Must not send invalid request');}) as typeof fetch),'invalid');
  }
});
test('provider failures are actionable fixed messages and never expose vendor diagnostics', async () => {
  for (const [status, expected] of [[401,'credentials'],[403,'credentials'],[404,'model'],[429,'limited'],[400,'rejected'],[503,'unavailable']] as const) {
    let cancelled = false;
    const result = await checkConnection(input,new AbortController().signal,(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('secret-key and raw private diagnostics'));},cancel(){cancelled=true;}}),{status})) as typeof fetch);
    assert.equal(result,expected);assert.ok(cancelled);assert.ok(!connectionMessages[result].includes('secret-key'));
  }
  assert.equal(await checkConnection(input,new AbortController().signal,(async()=>{throw Error('secret-key');}) as typeof fetch),'network');
});
test('metadata must be valid and bounded, and a stalled body can be cancelled', async () => {
  for(const data of ['not JSON', JSON.stringify({error:'secret-key'}), 'x'.repeat(2_000_001)]) {
    assert.equal(await checkConnection(input,new AbortController().signal,(async()=>new Response(data)) as typeof fetch),'unreadable');
  }
  const controller = new AbortController();let cancelled=false;
  const result=checkConnection(input,controller.signal,(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));queueMicrotask(()=>controller.abort());},cancel(){cancelled=true;}}))) as typeof fetch);
  assert.equal(await result,'cancelled');assert.ok(cancelled);
});
test('checks stop at the deadline without leaking timeout diagnostics', async t => {
  t.mock.method(AbortSignal,'timeout',()=>AbortSignal.abort(new DOMException('private diagnostic','TimeoutError')));
  assert.equal(await checkConnection(input,new AbortController().signal,(async()=>{assert.fail('Already timed out');}) as typeof fetch),'timeout');
});
