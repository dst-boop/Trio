import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { exportBackup, parseBackup, readBackupFile, planImport, mergeBackup, maxBackupBytes } from '../lib/backups.ts';
import { serializeSessions, type Session } from '../lib/sessions.ts';

function session(id = 'one', question = 'A question'): Session {
  return { id, title: question, time: '2026-09-22T01:00:00.000Z', turns: [{ question, mode: 'deep', imageName: 'photo.png', result: { drafts: { openai: 'First', claude: 'Second', gemini: 'Third' }, reviews: { claude: 'Critique' }, revisions: { openai: 'Revised' }, answer: 'Combined', by: 'openai', errors: ['Partial usage'], seconds: 1, demo: false, fallback: true, researchRequested: true, research: { text: '[Source](https://example.org/report)', sources: [{ url: 'https://example.org/report', title: 'Report' }], at: '2026-09-22T00:00:00.000Z' }, usage: { calls: 2, reportedCalls: 1, inputTokens: 10, outputTokens: 20, costUSD: null, byProvider: { openai: { model: 'model', calls: 2, reportedCalls: 1, inputTokens: 10, outputTokens: 20, costUSD: null } } } } }] };
}

test('portable backups round-trip complete conversations and strip unknown fields at every level', () => {
  const data: any = session();
  data.connections = { openai: { key: 'secret-not-for-export' } }; data.turns[0].image = { data: 'private-bytes' }; data.turns[0].result.research.key = 'secret-not-for-export'; data.turns[0].result.usage.byProvider.openai.key = 'secret-not-for-export';
  const text = exportBackup([data]);
  assert.ok(!text.includes('secret-not-for-export')); assert.ok(!text.includes('private-bytes'));
  assert.deepEqual(parseBackup(text), [session()]);
  const parsed = JSON.parse(text); parsed.key = 'secret-not-for-import'; parsed.sessions[0].turns[0].result.drafts.apiKey = 'secret-not-for-import';
  assert.ok(!JSON.stringify(parseBackup(JSON.stringify(parsed))).includes('secret-not-for-import'));
  assert.equal(parsed.format, 'trio-workspace'); assert.equal(parsed.version, 2);
});

test('V2 exports are rejected by the legacy version gate, while all V1 data remains readable', () => {
  const legacy = readFileSync(new URL('./fixtures/workspace-v1.json', import.meta.url), 'utf8');
  const parsed = parseBackup(legacy); assert.deepEqual(parsed, JSON.parse(legacy).sessions);
  const upgraded = exportBackup(parsed); assert.equal(JSON.parse(upgraded).version, 2); assert.deepEqual(parseBackup(upgraded), parsed);
  const withInstructions = session(); withInstructions.instructions = 'Current session preferences';
  withInstructions.turns[0].instructions = 'Historical instructions used'; withInstructions.turns[0].pdfName = 'report.pdf';
  const current = exportBackup([withInstructions]);
  // This is the version check shipped by V1 clients, before unknown fields are stripped.
  const legacyVersionGate = z.object({ format: z.literal('trio-workspace'), version: z.literal(1) });
  assert.equal(legacyVersionGate.safeParse(JSON.parse(current)).success, false);
  // Some V1 files were already written with instructions before the version bump.
  const transitional = JSON.stringify({ ...JSON.parse(current), version: 1 });
  assert.deepEqual(parseBackup(transitional), [withInstructions]);
  assert.deepEqual(parseBackup(exportBackup(parseBackup(transitional))), [withInstructions]);
});

test('unsupported, partial, invalid, and duplicate-ID files are rejected as a whole', () => {
  const good = JSON.parse(exportBackup([session()]));
  for (const value of [null, [], { ...good, version: 3 }, { ...good, format: 'other' }, { ...good, exportedAt: 'bad-date' }, { ...good, sessions: [] }, { ...good, sessions: [...good.sessions, { ...session('bad'), turns: [null] }] }, { ...good, sessions: [session(), session()] }, { ...good, sessions: Array.from({ length: 31 }, (_, i) => session(String(i))) }]) assert.throws(() => parseBackup(JSON.stringify(value)), /supported Trio backup/);
  assert.throws(() => parseBackup('{not-json'), /valid JSON/);
  const unsafe = session(); unsafe.turns[0].result.research!.sources[0].url = 'javascript:alert(1)';
  assert.throws(() => parseBackup(JSON.stringify({ ...good, sessions: [unsafe] })), /supported Trio backup/);
});

test('oversized files are rejected before reading and byte limits also cover multibyte text', async () => {
  let read = false;
  await assert.rejects(readBackupFile({ size: maxBackupBytes + 1, text: async () => { read = true; return ''; } }), /20 MB/);
  assert.equal(read, false);
  assert.throws(() => parseBackup('é'.repeat(maxBackupBytes / 2 + 1)), /20 MB/);
  await assert.rejects(readBackupFile({ size: 1, text: async () => { throw new Error('secret filename'); } }), /could not be read/);
});

test('duplicate content is skipped across devices despite identity, timestamp, or object field order', () => {
  const original = session();
  const imported = parseBackup(exportBackup([{ ...session('other-device'), time: '2026-09-23T00:00:00.000Z' }]))[0];
  assert.notEqual(JSON.stringify(original.turns), JSON.stringify(imported.turns), 'fixture has different field order after schema normalization');
  const plan = mergeBackup([original], [imported]);
  assert.equal(plan.added, 0); assert.equal(plan.skipped, 1); assert.deepEqual(plan.sessions, [original]);
});

test('conflicting IDs keep both versions and repeated imports are idempotent', () => {
  const original = session('x'.repeat(100)); const occupied = session(original.id.slice(0, 80) + '-copy-1', 'Occupied');
  const changed = session(original.id, 'Changed version');
  const before = JSON.stringify([original, occupied, changed]);
  const plan = mergeBackup([original, occupied], [changed]);
  assert.equal(plan.copies, 1); assert.equal(plan.added, 1); assert.equal(plan.sessions.length, 3);
  assert.equal(plan.sessions[2].id, original.id.slice(0, 80) + '-copy-2');
  assert.equal(JSON.stringify([original, occupied, changed]), before);
  assert.equal(mergeBackup(plan.sessions, [changed]).added, 0);
  assert.deepEqual(plan.sessions.slice(0, 2), [original, occupied]);
});

test('imports never evict existing sessions and selected subsets can fit remaining capacity', () => {
  const existing = Array.from({ length: 29 }, (_, i) => session(String(i), `Existing ${i}`));
  const incoming = [session('new-one', 'New one'), session('new-two', 'New two')];
  const preview = planImport(existing, incoming);
  assert.equal(preview.overCapacity, true); assert.equal(preview.sessions.length, 31);
  assert.throws(() => mergeBackup(existing, incoming), /30 sessions/);
  const subset = mergeBackup(existing, incoming.slice(0, 1));
  assert.equal(subset.sessions.length, 30); assert.deepEqual(subset.sessions.slice(0, 29), existing);
});

test('backups recover conversations larger than local history without truncating contributions', () => {
  const large = session(); large.turns[0].result.answer = 'a'.repeat(120000); large.turns = Array(43).fill(large.turns[0]);
  assert.throws(() => serializeSessions([large]), /storage limits/);
  const imported = parseBackup(exportBackup([large]));
  assert.equal(imported[0].turns.length, 43); assert.equal(imported[0].turns[42].result.answer.length, 120000);
  const plan = mergeBackup([], imported); assert.equal(plan.fitsLocalHistory, false); assert.equal(plan.overCapacity, false);
});
