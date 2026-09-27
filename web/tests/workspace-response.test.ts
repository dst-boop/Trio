import test from 'node:test';
import assert from 'node:assert/strict';
import { readWorkspaceResponse } from '../lib/workspace-response.ts';

test('history conflicts remain actionable with JSON, HTML, or empty error bodies', async () => {
  for (const body of ['', '<html>private upstream detail</html>', '{}']) {
    await assert.rejects(readWorkspaceResponse(new Response(body, { status: 409 }), 'save'), /Another tab or device saved newer changes/);
  }
  await assert.rejects(readWorkspaceResponse(Response.json({ error: 'History format changed. Reload first.' }, { status: 409 }), 'save'), /History format changed/);
});

test('unreadable saves are unconfirmed rather than leaking parser diagnostics', async () => {
  for (const status of [200, 502, 503]) {
    await assert.rejects(readWorkspaceResponse(new Response('<html>private response</html>', { status }), 'save'), { message: 'Your save was not confirmed. Retry saving, or download a backup before closing this tab.' });
  }
  for (const error of ['', 'x'.repeat(2001), { secret: 'private response' }]) {
    await assert.rejects(readWorkspaceResponse(Response.json({ error }, { status: 503 }), 'save'), /Your save was not confirmed/);
  }
});

test('loading has a useful retry message and successful payloads remain validated by the caller', async () => {
  await assert.rejects(readWorkspaceResponse(new Response('', { status: 502 }), 'load'), /temporarily unavailable.*retry loading/);
  await assert.rejects(readWorkspaceResponse(Response.json({ error: 'Please sign in again.' }, { status: 401 }), 'load'), /Please sign in again/);
  assert.deepEqual(await readWorkspaceResponse(Response.json({ revision: 2 }), 'save'), { revision: 2 });
});
