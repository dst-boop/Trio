import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchSessions, renameSession, maxSessionTitle } from '../lib/session-library.ts';
import { serializeSessions, parseSessions, type Session } from '../lib/sessions.ts';
import { exportBackup, parseBackup } from '../lib/backups.ts';

function session(id: string, title: string): Session {
  return { id, title, time: '2026-09-22', instructions: 'Small business audience', turns: [{ question: 'Launch a product', mode: 'deep', instructions: 'Older audience', imageName: 'diagram.png', pdfName: 'report.pdf', result: { drafts: { claude: 'Unusual perspective' }, reviews: { openai: 'Budget critique' }, revisions: { gemini: 'Revised milestone' }, answer: 'Starfruit roadmap', errors: ['Missing web evidence'], seconds: 1, demo: false, research: { text: 'Cited research', sources: [{ title: 'Primary report', url: 'https://example.org/evidence' }], at: '' } } }] };
}

test('search covers saved content and metadata without changing order or consulting connection state', () => {
  const first = session('one', 'Product plan'), second = session('two', 'Other project'); second.turns = [{ ...second.turns[0], question: 'Unrelated question', instructions: '', imageName: '', pdfName: '', result: { drafts: {}, reviews: {}, answer: 'Unrelated answer', errors: [], seconds: 1, demo: true } }]; second.instructions = '';
  const sessions = [first, second];
  for (const query of ['PRODUCT PLAN', 'starfruit', 'unusual perspective', 'budget critique', 'revised milestone', 'older audience', 'small business', 'report.pdf', 'diagram.png', 'primary report', 'example.org/evidence', 'missing web evidence', 'cited research', 'product starfruit']) assert.deepEqual(searchSessions(sessions, query).map(s => s.id), ['one']);
  assert.equal(searchSessions(sessions, '   '), sessions); assert.deepEqual(searchSessions(sessions, 'question').map(s => s.id), ['two']);
  assert.deepEqual(searchSessions(sessions, '.*'), []); assert.deepEqual(searchSessions(sessions, 'not found'), []);
  const extra: any = { ...first, connections: { openai: { key: 'private-key' } }, attachmentBytes: 'private-original-bytes' };
  assert.deepEqual(searchSessions([extra], 'private-key'), []); assert.deepEqual(searchSessions([extra], 'private-original-bytes'), []);
});

test('renaming preserves IDs, order, timestamps, instructions and every original turn', () => {
  const first = session('one', 'Old name'), second = session('two', 'Other name'), sessions = [first, second];
  const next = renameSession(sessions, 'one', '  New project\nname  ');
  assert.equal(next[0].title, 'New project name'); assert.equal(first.title, 'Old name'); assert.equal(next[0].id, first.id); assert.equal(next[0].time, first.time); assert.equal(next[0].instructions, first.instructions); assert.equal(next[0].turns, first.turns); assert.equal(next[1], second);
  assert.equal(parseSessions(serializeSessions(next))[0].title, 'New project name'); assert.equal(parseBackup(exportBackup(next))[0].turns[0].question, 'Launch a product');
  assert.equal(renameSession(sessions, 'one', 'x'.repeat(maxSessionTitle))[0].title.length, maxSessionTitle);
});

test('invalid names and stale targets do not mutate the session collection', () => {
  const sessions = [session('one', 'Original')], before = JSON.stringify(sessions);
  for (const title of ['', ' \n ', '\u0000', 'x'.repeat(maxSessionTitle + 1)]) assert.throws(() => renameSession(sessions, 'one', title), /between 1 and 120/);
  assert.throws(() => renameSession(sessions, 'missing', 'New name'), /no longer available/); assert.equal(JSON.stringify(sessions), before);
});
