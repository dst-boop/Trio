import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { readWorkspace, writeWorkspace } from '../lib/account-store.ts';
import type { Session } from '../lib/sessions.ts';

function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../drizzle/0000_thick_doctor_spectrum.sql', import.meta.url), 'utf8'));
  const prepare = (query: string, values: unknown[] = []) => ({
    bind: (...bindings: unknown[]) => prepare(query, bindings),
    all: async () => ({ results: sql.prepare(query).all(...values as never[]) }),
    run: () => { if (query.startsWith('SELECT')) return { results: sql.prepare(query).all(...values as never[]), meta: { changes: 0 } }; const value = sql.prepare(query).run(...values as never[]); return { results: [], meta: { changes: Number(value.changes) } }; },
  });
  const db = { prepare, batch: async (statements: { run: () => unknown }[]) => { sql.exec('BEGIN'); try { const results = statements.map(s => s.run()); sql.exec('COMMIT'); return results; } catch (e) { sql.exec('ROLLBACK'); throw e; } } } as unknown as D1Database;
  return { db, sql };
}
const session = (text = 'Private answer'): Session => ({ id: 'shared-session-id', title: 'Private project', time: '', turns: [{ question: 'Help', mode: 'fast', result: { answer: text, drafts: {}, reviews: {}, errors: [], seconds: 1, demo: false } }] });

test('retrying the same save acknowledges one committed revision; changed content cannot reuse its receipt', async () => {
  const { db, sql } = database();
  try {
    const request = { revision: 0, requestId: crypto.randomUUID(), sessions: [session('Committed despite a lost response')] };
    assert.equal(await writeWorkspace(db, 'alice', request), true);
    assert.equal(await writeWorkspace(db, 'alice', structuredClone(request)), true);
    assert.deepEqual(await readWorkspace(db, 'alice'), { revision: 1, sessions: request.sessions });
    assert.equal(await writeWorkspace(db, 'alice', { ...request, sessions: [session('Changed during retry')] }), false);
    assert.equal((await readWorkspace(db, 'alice')).sessions[0].turns[0].result.answer, 'Committed despite a lost response');
    assert.equal(await writeWorkspace(db, 'alice', { revision: 1, requestId: crypto.randomUUID(), sessions: [session('A later device save')] }), true);
    assert.equal(await writeWorkspace(db, 'alice', request), false);
    assert.deepEqual(await readWorkspace(db, 'alice'), { revision: 2, sessions: [session('A later device save')] });
  } finally { sql.close(); }
});

test('simultaneous retries share a revision, receipts are account-scoped, and invalid IDs fail before writing', async () => {
  const { db, sql } = database();
  try {
    const request = { revision: 0, requestId: crypto.randomUUID(), sessions: [session()] };
    assert.deepEqual(await Promise.all([writeWorkspace(db, 'alice', request), writeWorkspace(db, 'alice', request)]), [true, true]);
    assert.equal((await readWorkspace(db, 'alice')).revision, 1);
    assert.equal(await writeWorkspace(db, 'bob', { ...request, sessions: [session('Bob private')] }), true);
    assert.equal((await readWorkspace(db, 'alice')).sessions[0].turns[0].result.answer, 'Private answer');
    assert.equal(await writeWorkspace(db, 'alice', { revision: 0, sessions: request.sessions }), false);
    await assert.rejects(writeWorkspace(db, 'alice', { ...request, revision: 1, requestId: 'not-a-valid-id' }));
    assert.equal((await readWorkspace(db, 'alice')).revision, 1);
  } finally { sql.close(); }
});

test('account histories are isolated even with matching conversation IDs; stale writes do not replace', async () => {
  const { db, sql } = database();
  try {
    assert.deepEqual(await readWorkspace(db, 'alice'), { revision: 0, sessions: [] });
    assert.equal(await writeWorkspace(db, 'alice', { revision: 0, sessions: [session('Alice secret')] }), true);
    assert.deepEqual(await readWorkspace(db, 'bob'), { revision: 0, sessions: [] });
    assert.equal(await writeWorkspace(db, 'bob', { revision: 0, sessions: [session('Bob secret')] }), true);
    assert.equal(await writeWorkspace(db, 'alice', { revision: 0, sessions: [] }), false);
    assert.equal((await readWorkspace(db, 'alice')).sessions[0].turns[0].result.answer, 'Alice secret');
    assert.equal(await writeWorkspace(db, 'bob', { revision: 1, sessions: [] }), true);
    assert.deepEqual(await readWorkspace(db, 'bob'), { revision: 2, sessions: [] });
    assert.equal((await readWorkspace(db, 'alice')).revision, 1);
  } finally { sql.close(); }
});
test('large unicode history spans bounded chunks and round-trips; unknown credentials are stripped', async () => {
  const { db, sql } = database();
  try {
    const item = session('🌍'.repeat(55000)); item.turns = Array.from({ length: 8 }, () => structuredClone(item.turns[0]));
    assert.equal(await writeWorkspace(db, 'alice', { revision: 0, sessions: [{ ...item, key: 'never-store-this' } as Session] }), true);
    assert.deepEqual((await readWorkspace(db, 'alice')).sessions, [item]);
    const rows = sql.prepare('SELECT content FROM workspace_chunks').all() as { content: string }[];
    assert.ok(rows.length > 1); assert.ok(rows.every(r => Buffer.byteLength(r.content) < 1_000_000));
    assert.ok(!JSON.stringify(rows).includes('never-store-this'));
  } finally { sql.close(); }
});
test('failed transaction and invalid snapshot preserve previously committed history', async () => {
  const { db, sql } = database();
  try {
    await writeWorkspace(db, 'alice', { revision: 0, sessions: [session()] });
    sql.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON workspace_chunks BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await assert.rejects(writeWorkspace(db, 'alice', { revision: 1, sessions: [] }));
    assert.deepEqual(await readWorkspace(db, 'alice'), { revision: 1, sessions: [session()] });
    await assert.rejects(writeWorkspace(db, 'alice', { revision: 1, sessions: [session('x'.repeat(120001))] }));
    assert.equal((await readWorkspace(db, 'alice')).revision, 1);
  } finally { sql.close(); }
});
