import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { assertWorkspaceCallsLeft, chargeWorkspaceCalls, dailyWorkspaceCalls, defaultDailyWorkspaceCalls } from '../lib/workspace-budget.ts';

function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../drizzle/0006_workspace_usage.sql', import.meta.url), 'utf8'));
  const db = { prepare: (query: string) => ({ bind: (...values: unknown[]) => ({ first: async () => sql.prepare(query).get(...values as never[]) ?? null }) }) } as unknown as D1Database;
  const used = (user: string, day: string) => (sql.prepare('SELECT calls FROM workspace_usage WHERE user_id = ? AND day = ?').get(user, day) as { calls: number } | undefined)?.calls;
  return { db, sql, used };
}
const noon = Date.UTC(2026, 8, 27, 12), nextDay = Date.UTC(2026, 8, 28, 0, 0, 1);

test('the allowance is reserved per account and day, and refuses the call that would exceed it', async () => {
  const { db, sql, used } = database();
  try {
    const env = { DB: db, TRIO_WORKSPACE_DAILY_CALLS: '10' };
    await chargeWorkspaceCalls(env, 'alice', 4, noon);
    await chargeWorkspaceCalls(env, 'alice', 6, noon);
    assert.equal(used('alice', '2026-09-27'), 10);
    await assert.rejects(chargeWorkspaceCalls(env, 'alice', 1, noon), (e: Error & { status?: number }) => e.status === 429 && /own API key/.test(e.message));
    assert.equal(used('alice', '2026-09-27'), 10, 'a refused reservation is not recorded');
    // Other accounts and the next UTC day have their own allowance.
    await chargeWorkspaceCalls(env, 'bob', 10, noon);
    await chargeWorkspaceCalls(env, 'alice', 3, nextDay);
    assert.equal(used('alice', '2026-09-28'), 3);
    // A single request larger than the whole allowance never gets in, even on a fresh day.
    await assert.rejects(chargeWorkspaceCalls(env, 'carol', 11, noon), /used up/);
    assert.equal(used('carol', '2026-09-27'), undefined);
  } finally { sql.close(); }
});

test('simultaneous reservations cannot overspend together', async () => {
  const { db, sql, used } = database();
  try {
    const env = { DB: db, TRIO_WORKSPACE_DAILY_CALLS: '5' };
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => chargeWorkspaceCalls(env, 'alice', 1, noon)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 5);
    assert.equal(used('alice', '2026-09-27'), 5);
  } finally { sql.close(); }
});

test('zero calls, a disabled cap and a missing database behave predictably', async () => {
  await chargeWorkspaceCalls({}, 'alice', 0); // nothing workspace-funded: no database needed
  await chargeWorkspaceCalls({ TRIO_WORKSPACE_DAILY_CALLS: '0' }, 'alice', 50);
  await assert.rejects(chargeWorkspaceCalls({}, 'alice', 1), (e: Error & { status?: number }) => e.status === 503);
  assert.equal(dailyWorkspaceCalls({}), defaultDailyWorkspaceCalls);
  assert.equal(dailyWorkspaceCalls({ TRIO_WORKSPACE_DAILY_CALLS: ' 25 ' }), 25);
  for (const bad of ['-1', 'lots', '1e3', '12345678']) assert.equal(dailyWorkspaceCalls({ TRIO_WORKSPACE_DAILY_CALLS: bad }), defaultDailyWorkspaceCalls);
});

test('a run is refused up front only once the allowance is fully used', async () => {
  const { db, sql } = database();
  try {
    const env = { DB: db, TRIO_WORKSPACE_DAILY_CALLS: '2' };
    await assertWorkspaceCallsLeft(env, 'alice', noon);
    await chargeWorkspaceCalls(env, 'alice', 1, noon);
    await assertWorkspaceCallsLeft(env, 'alice', noon);
    await chargeWorkspaceCalls(env, 'alice', 1, noon);
    await assert.rejects(assertWorkspaceCallsLeft(env, 'alice', noon), (e: Error & { status?: number }) => e.status === 429);
    await assertWorkspaceCallsLeft(env, 'alice', nextDay);
    await assertWorkspaceCallsLeft({ TRIO_WORKSPACE_DAILY_CALLS: '0' }, 'alice');
  } finally { sql.close(); }
});
