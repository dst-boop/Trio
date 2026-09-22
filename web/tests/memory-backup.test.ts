import test from 'node:test';
import assert from 'node:assert/strict';
import { exportMemoryBackup, parseMemoryBackup, readMemoryBackupFile, memoryDraftFromBackup } from '../lib/memory-backup.ts';

test('memory backups round-trip preferences while stripping account, revision and credential fields', () => {
  const profile = { notes: 'Use practical examples.\nI work with 🌍 data.', enabled: true, revision: 99, accountId: 'someone', key: 'private-test-key' };
  const encoded = exportMemoryBackup(profile), backup = parseMemoryBackup(encoded);
  assert.deepEqual(backup.memory, { notes: profile.notes, enabled: true });
  assert.equal(backup.format, 'trio-personal-memory'); assert.equal(backup.version, 1);
  assert.deepEqual(Object.keys(backup).sort(), ['exportedAt', 'format', 'memory', 'version']);
  for (const secret of ['revision', 'accountId', 'private-test-key']) assert.ok(!encoded.includes(secret));
});
test('all supported note lengths fit including worst-case JSON escapes and Unicode', () => {
  for (const notes of ['', '🌍'.repeat(2000), '\u0000'.repeat(4000), '\\'.repeat(4000), '\n'.repeat(4000), '漢'.repeat(4000)]) {
    const encoded = exportMemoryBackup({ notes, enabled: false });
    assert.ok(new TextEncoder().encode(encoded).length < 32_000);
    assert.deepEqual(parseMemoryBackup(encoded).memory, { notes, enabled: false });
  }
  assert.throws(() => exportMemoryBackup({ notes: 'a'.repeat(4001), enabled: true }), /4,000/);
});
test('memory import rejects invalid files atomically and never reflects file contents in errors', async () => {
  const backup = JSON.parse(exportMemoryBackup({ notes: 'Keep me', enabled: true }));
  for (const input of [{ ...backup, version: 2 }, { ...backup, format: 'trio-workspace' }, { ...backup, exportedAt: 'invalid' }, { ...backup, accountId: 'someone' }, { ...backup, memory: { ...backup.memory, revision: 44 } }, { ...backup, memory: { notes: 'x'.repeat(4001), enabled: false } }, { ...backup, memory: { notes: 'Words', enabled: 'yes' } }, { ...backup, memory: null }]) assert.throws(() => parseMemoryBackup(JSON.stringify(input)), /not a supported personal memory backup/);
  assert.throws(() => parseMemoryBackup('{private-test-key'), error => { assert.ok(error instanceof Error); assert.ok(!error.message.includes('private-test-key')); return true; });
  assert.throws(() => parseMemoryBackup(' '.repeat(32_001)), /under 32 KB/);
  assert.throws(() => parseMemoryBackup('漢'.repeat(11_000)), /under 32 KB/);
  let read = false;
  await assert.rejects(readMemoryBackupFile({ size: 32_001, text: async () => { read = true; return ''; } }), /under 32 KB/); assert.equal(read, false);
  await assert.rejects(readMemoryBackupFile({ size: 1, text: async () => ' '.repeat(32_001) }), /under 32 KB/);
  await assert.rejects(readMemoryBackupFile({ size: 1, text: async () => { throw new Error('private-test-key'); } }), /Could not read this memory backup/);
});
test('restoring creates a disabled draft only, independent of previous sharing settings', async () => {
  for (const enabled of [true, false]) {
    const text = exportMemoryBackup({ notes: 'Review before using', enabled });
    const backup = await readMemoryBackupFile(new File([text], 'memory.json'));
    const draft = memoryDraftFromBackup(backup);
    assert.deepEqual(draft, { notes: 'Review before using', enabled: false });
    assert.equal(backup.memory.enabled, enabled);
    assert.ok(!('revision' in draft)); assert.ok(!('accountId' in draft));
  }
});
