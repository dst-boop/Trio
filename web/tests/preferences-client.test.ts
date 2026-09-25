import test from 'node:test';
import assert from 'node:assert/strict';
import { PreferencesClient } from '../lib/preferences-client.ts';
import { defaultPreferences, workspacePreferencesSchema, type WorkspacePreferences } from '../lib/workspace-preferences.ts';

const response = (value = defaultPreferences, accountId = 'alice') => Response.json({ ...value, accountId });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settled(client: PreferencesClient) {
  for (let n = 0; n < 50; n++) { await tick(); if (!['saving', 'loading'].includes(client.getSnapshot().status)) return; }
  assert.fail('Preference operation did not settle');
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }

test('preferences are bounded choices and never accept key material or unknown fields', () => {
  assert.ok(workspacePreferencesSchema.safeParse(defaultPreferences).success);
  for (const patch of [{ key: 'secret' }, { accountId: 'bob' }, { demo: 'false' }, { mode: 'unknown' }, { lead: 'other' }, { revision: -1 }, { revision: Number.MAX_SAFE_INTEGER }]) {
    assert.equal(workspacePreferencesSchema.safeParse({ ...defaultPreferences, ...patch }).success, false);
  }
});

test('hydration restores the saved live choices without writing or calling providers', async () => {
  const calls: RequestInit[] = [];
  const saved: WorkspacePreferences = { revision: 7, demo: false, mode: 'fast', lead: 'gemini' };
  const client = new PreferencesClient('alice', async (url, init) => { assert.equal(url, '/api/preferences'); calls.push(init); return response(saved); });
  await client.load();
  assert.deepEqual(client.getSnapshot().value, { demo: false, mode: 'fast', lead: 'gemini' });
  assert.equal(client.getSnapshot().status, 'saved'); assert.equal(calls.length, 1); assert.equal(calls[0].method, undefined);
  assert.equal((calls[0].headers as Record<string, string>)['X-Trio-Account'], 'alice');
  client.update({ lead: 'gemini' }); await tick(); assert.equal(calls.length, 1);
  client.dispose();
});

test('rapid changes serialize actual writes and preserve the latest choices', async () => {
  const pending = deferred<Response>(); const writes: WorkspacePreferences[] = [];
  const client = new PreferencesClient('alice', async (_, init) => {
    if (!init.method) return response();
    const body = JSON.parse(init.body as string); writes.push(body);
    return writes.length === 1 ? pending.promise : response({ ...body, revision: body.revision + 1 });
  });
  await client.load(); client.update({ demo: false }); client.update({ lead: 'claude' }); client.update({ mode: 'deep' });
  assert.equal(writes.length, 1); assert.deepEqual(writes[0], { ...defaultPreferences, demo: false });
  pending.resolve(response({ ...writes[0], revision: 1 })); await settled(client);
  assert.equal(writes.length, 2); assert.deepEqual(writes[1], { revision: 1, demo: false, lead: 'claude', mode: 'deep' });
  assert.equal(client.getSnapshot().status, 'saved'); client.dispose();
});

test('lost acknowledgement retries the original intent before saving newer choices', async () => {
  const writes: WorkspacePreferences[] = [];
  const client = new PreferencesClient('alice', async (_, init) => {
    if (!init.method) return response();
    const body = JSON.parse(init.body as string); writes.push(body);
    if (writes.length === 1) throw new Error('Lost response after commit');
    return response({ ...body, revision: body.revision + 1 });
  });
  await client.load(); client.update({ demo: false }); await settled(client);
  client.update({ mode: 'council' }); assert.equal(writes.length, 1);
  client.retry(); await settled(client);
  assert.deepEqual(writes[0], writes[1]); assert.equal(writes[2].revision, 1); assert.equal(writes[2].mode, 'council');
  assert.equal(client.getSnapshot().status, 'saved'); client.dispose();
});

test('stale tab conflict blocks writes until explicit load, which never writes', async () => {
  let writes = 0, reads = 0;
  const client = new PreferencesClient('alice', async (_, init) => {
    if (!init.method) return response(reads++ ? { revision: 8, demo: false, mode: 'compare', lead: 'gemini' } : defaultPreferences);
    writes++; return Response.json({ error: 'conflict' }, { status: 409 });
  });
  await client.load(); client.update({ demo: false }); await settled(client);
  assert.equal(client.getSnapshot().recovery, 'load'); client.update({ mode: 'deep' }); client.retry(); assert.equal(writes, 1);
  await client.load(); assert.equal(writes, 1); assert.equal(client.getSnapshot().value.mode, 'compare'); client.dispose();
});

test('failed reads allow temporary choices but never write unknown revisions', async () => {
  let writes = 0;
  const client = new PreferencesClient('alice', async (_, init) => { if (init.method) writes++; throw new Error('offline'); });
  await client.load(); client.update({ demo: false, mode: 'fast' }); client.retry();
  assert.deepEqual(client.getSnapshot().value, { demo: false, mode: 'fast', lead: 'openai' });
  assert.equal(client.getSnapshot().recovery, 'load'); assert.equal(writes, 0); client.dispose();
});

test('account mismatch and disposed requests cannot publish or save a different account state', async () => {
  const mismatch = new PreferencesClient('alice', async () => response({ ...defaultPreferences, demo: false }, 'bob'));
  await mismatch.load(); assert.equal(mismatch.getSnapshot().recovery, 'account'); assert.equal(mismatch.getSnapshot().value.demo, true); mismatch.dispose();
  const pending = deferred<Response>(); let calls = 0;
  const old = new PreferencesClient('alice', async () => { calls++; return pending.promise; });
  const loading = old.load(); old.dispose(); pending.resolve(response({ ...defaultPreferences, demo: false })); await loading;
  old.update({ demo: false }); assert.equal(old.getSnapshot().value.demo, true); assert.equal(calls, 1);
  const current = new PreferencesClient('bob', async () => response(defaultPreferences, 'bob'));
  await current.load(); assert.equal(current.getSnapshot().value.demo, true); current.dispose();
});

test('late save acknowledgement cannot replace a newer explicit load', async () => {
  const pending = deferred<Response>(); let reads = 0, writes = 0;
  const client = new PreferencesClient('alice', async (_, init) => {
    if (!init.method) return response(reads++ ? { revision: 2, demo: true, mode: 'compare', lead: 'claude' } : defaultPreferences);
    writes++; return pending.promise;
  });
  await client.load(); client.update({ demo: false }); await client.load();
  pending.resolve(response({ ...defaultPreferences, demo: false, revision: 1 })); await settled(client);
  assert.equal(client.getSnapshot().value.mode, 'compare'); assert.equal(client.getSnapshot().value.demo, true); assert.equal(writes, 1); client.dispose();
});

test('malformed acknowledgement is recoverable without trusting it as saved', async () => {
  const client = new PreferencesClient('alice', async (_, init) => init.method ? response({ ...defaultPreferences, revision: 50 }) : response());
  await client.load(); client.update({ demo: false }); await settled(client);
  assert.equal(client.getSnapshot().status, 'error'); assert.equal(client.getSnapshot().recovery, 'retry'); client.dispose();
});

test('guest and effect cleanup/restart keep temporary choices usable without persistence', async () => {
  let calls = 0; const client = new PreferencesClient(undefined, async () => { calls++; return response(); });
  await client.load(); client.dispose(); await client.load(); client.update({ mode: 'deep' });
  assert.equal(client.getSnapshot().value.mode, 'deep'); assert.equal(client.getSnapshot().status, 'local'); assert.equal(calls, 0); client.dispose();
});

test('default browser transport calls fetch without binding it to the client instance', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async function (this: unknown, input, init) {
    assert.ok(this === undefined || this === globalThis, 'Native browser fetch rejects an unrelated receiver');
    assert.equal(input, '/api/preferences');
    const value = init?.method ? JSON.parse(init.body as string) : defaultPreferences;
    return response(init?.method ? { ...value, revision: value.revision + 1 } : value);
  };
  try {
    const client = new PreferencesClient('alice'); await client.load();
    assert.equal(client.getSnapshot().status, 'saved'); assert.equal(client.getSnapshot().persisted, false);
    client.update({ demo: false }); await settled(client);
    assert.equal(client.getSnapshot().status, 'saved'); assert.equal(client.getSnapshot().persisted, true); client.dispose();
  } finally { globalThis.fetch = original; }
});

test('actual read-side 401 requires a page reload and never offers a dead retry loop', async () => {
  let calls = 0;
  const client = new PreferencesClient('alice', async () => { calls++; return Response.json({ error: 'Account changed' }, { status: 401 }); });
  await client.load(); assert.equal(client.getSnapshot().recovery, 'account'); assert.match(client.getSnapshot().error, /account changed/i);
  client.update({ demo: false }); client.retry(); assert.equal(calls, 1); client.dispose();
});

test('permanent request errors do not offer repeated retries with the same invalid payload', async () => {
  for (const status of [400, 403, 413, 415]) {
    let writes = 0;
    const client = new PreferencesClient('alice', async (_, init) => {
      if (!init.method) return response(); writes++; return Response.json({ error: 'Invalid' }, { status });
    });
    await client.load(); client.update({ demo: false }); await settled(client);
    assert.equal(client.getSnapshot().recovery, 'account'); assert.match(client.getSnapshot().error, /Reload Trio/);
    client.retry(); assert.equal(writes, 1); client.dispose();
  }
});
