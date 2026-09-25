import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorkspaceConnections, resolveRequestKey, workspaceAvailability } from '../lib/workspace-keys.ts';
import { savedKeyReference, workspaceKeyReference, saveConnectionSchema, savedConnectionsSchema } from '../lib/saved-connections.ts';
import { freshConnections } from '../lib/trio.ts';

const request = (account = 'alice', origin = 'https://trio.test') => new Request('https://trio.test/api/ask', { headers: { 'X-Trio-Account': account, ...(origin ? { Origin: origin } : {}) } });
const env = { TRIO_WORKSPACE_OPENAI_KEY: ' workspace-openai-key ', TRIO_WORKSPACE_CLAUDE_KEY: '   ' };

test('availability requires a plausible configured secret', () => {
  assert.deepEqual(workspaceAvailability(env), { openai: true, claude: false, gemini: false });
  assert.deepEqual(workspaceAvailability({}), { openai: false, claude: false, gemini: false });
  // References, short values, and values with spaces are never treated as usable keys.
  for (const bad of [savedKeyReference, workspaceKeyReference, 'short', 'two words', 'x'.repeat(1025)])
    assert.equal(workspaceAvailability({ TRIO_WORKSPACE_GEMINI_KEY: bad }).gemini, false);
});
test('workspace keys resolve only for the pinned signed-in account and same origin', async () => {
  assert.equal(await resolveRequestKey(env, request(), 'alice', 'openai', workspaceKeyReference), 'workspace-openai-key');
  await assert.rejects(resolveRequestKey(env, request('bob'), 'alice', 'openai', workspaceKeyReference), /account changed/i);
  await assert.rejects(resolveRequestKey(env, request('alice', ''), 'alice', 'openai', workspaceKeyReference), /Reload Trio/);
  await assert.rejects(resolveRequestKey(env, request(), 'alice', 'gemini', workspaceKeyReference), /not configured/);
  // Quality runs pin saved-key revisions, so workspace references are refused there.
  await assert.rejects(resolveRequestKey(env, request(), 'alice', 'openai', workspaceKeyReference, 3), /saved keys/i);
  // Non-workspace values keep their existing behavior: literals pass through, saved references need the vault.
  assert.equal(await resolveRequestKey(env, request(), 'alice', 'openai', 'literal-key'), 'literal-key');
  await assert.rejects(resolveRequestKey(env, request(), 'alice', 'openai', savedKeyReference), /unavailable/i);
});
test('workspace defaults fill only key-less connections', () => {
  const connections = { ...freshConnections(), claude: { key: 'own-key', model: 'model', enabled: true }, gemini: { key: savedKeyReference, model: 'model', enabled: false } };
  const applied = applyWorkspaceConnections(connections, { openai: true, claude: true, gemini: true });
  assert.equal(applied.openai.key, workspaceKeyReference);
  assert.equal(applied.claude.key, 'own-key');
  assert.equal(applied.gemini.key, savedKeyReference);
  assert.equal(applyWorkspaceConnections(freshConnections(), { openai: false }).openai.key, '');
  assert.equal(applyWorkspaceConnections(freshConnections(), undefined).openai.key, '');
});
test('references are never accepted as saveable keys and availability metadata stays boolean', () => {
  for (const key of [savedKeyReference, workspaceKeyReference])
    assert.equal(saveConnectionSchema.safeParse({ provider: 'openai', revision: 0, key, model: 'model', enabled: true }).success, false);
  const connections = (['openai', 'claude', 'gemini'] as const).map(provider => ({ provider, revision: 0, saved: false, model: 'model', enabled: true, updatedAt: null }));
  assert.equal(savedConnectionsSchema.safeParse({ connections }).success, true);
  assert.equal(savedConnectionsSchema.safeParse({ connections, workspace: { openai: true, claude: false, gemini: false } }).success, true);
  assert.equal(savedConnectionsSchema.safeParse({ connections, workspace: { openai: 'yes', claude: false, gemini: false } }).success, false);
  assert.equal(savedConnectionsSchema.safeParse({ connections, workspace: { openai: true } }).success, false);
});
