import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { decryptCredential, encryptCredential } from '../lib/credential-crypto.ts';
import { readSavedConnections, saveCredential, deleteCredential, resolveCredential } from '../lib/credential-store.ts';
import { savedKeyReference, saveConnectionSchema } from '../lib/saved-connections.ts';

const master = Buffer.alloc(32, 7).toString('base64');
const request = (account = 'alice', origin = 'https://trio.test') => new Request('https://trio.test/api/ask', { headers: { 'X-Trio-Account': account, Origin: origin } });
function database() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../drizzle/0002_typical_microchip.sql', import.meta.url), 'utf8'));
  const prepare = (query: string, values: unknown[] = []) => ({ bind: (...v: unknown[]) => prepare(query, v), first: async () => sql.prepare(query).get(...values as never[]) ?? null, run: () => ({ meta: sql.prepare(query).run(...values as never[]) }) });
  const db = { prepare, batch: async (statements: { run: () => unknown }[]) => { sql.exec('BEGIN'); try { const rows = statements.map(s => s.run()); sql.exec('COMMIT'); return rows; } catch (error) { sql.exec('ROLLBACK'); throw error; } } } as unknown as D1Database;
  return { sql, db };
}
const input = { provider: 'openai', key: 'synthetic-private-key', model: 'model', enabled: true, revision: 0 };
test('AES-GCM uses a fresh nonce and binds ciphertext to account/provider/master', async () => {
  const a = await encryptCredential(master, 'alice', 'openai', input.key);
  const b = await encryptCredential(master, 'alice', 'openai', input.key);
  assert.notEqual(a.iv, b.iv); assert.notEqual(a.cipher, b.cipher);
  assert.equal(await decryptCredential(master, 'alice', 'openai', a), input.key);
  for (const [key, account, provider] of [[master, 'bob', 'openai'], [master, 'alice', 'claude'], [Buffer.alloc(32, 8).toString('base64'), 'alice', 'openai']]) await assert.rejects(decryptCredential(key, account, provider, a));
  await assert.rejects(decryptCredential(master, 'alice', 'openai', { ...a, cipher: a.cipher.slice(4) }));
  for (const key of [undefined, '', 'short', Buffer.alloc(16).toString('base64')]) await assert.rejects(encryptCredential(key, 'alice', 'openai', input.key));
});
test('saved metadata excludes secrets; account/provider isolation and opt-in preference updates hold', async () => {
  const { db, sql } = database();
  try {
    const saved = await saveCredential(db, master, 'alice', input);
    assert.equal(saved.revision, 1); assert.equal(saved.saved, true);
    assert.ok(!JSON.stringify(await readSavedConnections(db, 'alice')).includes(input.key));
    const row = sql.prepare('SELECT * FROM provider_credentials').get()!;
    assert.ok(!JSON.stringify(row).includes(input.key)); assert.ok(!JSON.stringify(saved).includes('cipher'));
    assert.equal((await readSavedConnections(db, 'bob')).connections.every(c => !c.saved), true);
    assert.equal(await resolveCredential(db, master, request(), 'alice', 'openai', savedKeyReference), input.key);
    await assert.rejects(resolveCredential(db, master, request('bob'), 'bob', 'openai', savedKeyReference), /removed/);
    await assert.rejects(resolveCredential(db, master, request(), 'alice', 'claude', savedKeyReference), /removed/);
    await saveCredential(db, master, 'alice', { ...input, revision: 1, key: undefined, enabled: false, model: 'second-model' });
    assert.equal((await readSavedConnections(db, 'alice')).connections[0].model, 'second-model');
    assert.equal(await resolveCredential(db, master, request(), 'alice', 'openai', savedKeyReference), input.key);
  } finally { sql.close(); }
});
test('revision checks protect replacements and tombstones prevent deleted key resurrection', async () => {
  const { db, sql } = database();
  try {
    await saveCredential(db, master, 'alice', input);
    await assert.rejects(saveCredential(db, master, 'alice', { ...input, key: 'stale' }), /another tab/);
    await saveCredential(db, master, 'alice', { ...input, key: 'replacement', revision: 1 });
    await assert.rejects(deleteCredential(db, 'alice', { provider: 'openai', revision: 1 }), /another tab/);
    await deleteCredential(db, 'alice', { provider: 'openai', revision: 2 });
    for (const revision of [0, 1, 2]) await assert.rejects(saveCredential(db, master, 'alice', { ...input, revision }), /another tab/);
    await assert.rejects(resolveCredential(db, master, request(), 'alice', 'openai', savedKeyReference), /removed/);
    const row = sql.prepare('SELECT cipher, iv, revision FROM provider_credentials').get();
    assert.deepEqual({ ...row }, { cipher: null, iv: null, revision: 3 });
    await saveCredential(db, master, 'alice', { ...input, revision: 3 });
    assert.equal(await resolveCredential(db, master, request(), 'alice', 'openai', savedKeyReference), input.key);
  } finally { sql.close(); }
});
test('saved references require an exact account pin and origin; temporary keys do not require a vault', async () => {
  const { db, sql } = database();
  try {
    await saveCredential(db, master, 'alice', input);
    await assert.rejects(resolveCredential(db, master, request('bob'), 'alice', 'openai', savedKeyReference), /account changed/);
    await assert.rejects(resolveCredential(db, master, request('alice', 'https://other.test'), 'alice', 'openai', savedKeyReference), /Reload/);
    await assert.rejects(resolveCredential(db, undefined, request(), 'alice', 'openai', savedKeyReference), /unavailable/);
    assert.equal(await resolveCredential(undefined, undefined, request(), 'alice', 'openai', 'temporary'), 'temporary');
    assert.equal(saveConnectionSchema.safeParse({ ...input, key: savedKeyReference }).success, false);
    assert.equal(saveConnectionSchema.safeParse({ ...input, key: 'unsafe\nkey' }).success, false);
    assert.equal(saveConnectionSchema.safeParse({ ...input, userId: 'bob' }).success, false);
  } finally { sql.close(); }
});
