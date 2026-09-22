import { z } from 'zod';
import { memoryNotesSchema } from './memory.ts';

export const maxMemoryBackupBytes = 32_000;
const contentSchema = z.object({ notes: memoryNotesSchema, enabled: z.boolean() });
const envelopeSchema = z.object({
  format: z.literal('trio-personal-memory'), version: z.literal(1),
  exportedAt: z.string().datetime(), memory: contentSchema.strict(),
}).strict();
export type MemoryBackup = z.infer<typeof envelopeSchema>;
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** Copy only editable preferences; account identity, server revisions and credentials are never exported. */
export function exportMemoryBackup(content: { notes: string; enabled: boolean }): string {
  const parsed = contentSchema.safeParse(content);
  if (!parsed.success) throw new Error('These notes could not be backed up. Keep memory within 4,000 characters.');
  const text = JSON.stringify({ format: 'trio-personal-memory', version: 1, exportedAt: new Date().toISOString(), memory: parsed.data });
  if (bytes(text) > maxMemoryBackupBytes) throw new Error('This memory backup exceeds 32 KB. Copy the notes to a private file instead.');
  return text;
}

export function parseMemoryBackup(text: string): MemoryBackup {
  if (text.length > maxMemoryBackupBytes || bytes(text) > maxMemoryBackupBytes) throw new Error('Choose a personal memory backup under 32 KB.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('This file is not valid JSON. Choose a Trio personal memory backup.'); }
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) throw new Error('This is not a supported personal memory backup. Conversation backups belong in Back up & restore. No notes were changed.');
  return parsed.data;
}

export async function readMemoryBackupFile(file: Pick<File, 'size' | 'text'>): Promise<MemoryBackup> {
  if (!file.size || file.size > maxMemoryBackupBytes) throw new Error('Choose a personal memory backup under 32 KB.');
  let text: string;
  try { text = await file.text(); } catch { throw new Error('Could not read this memory backup. Choose the file again.'); }
  return parseMemoryBackup(text);
}

/** Restoring never re-enables sharing based on an old file; the user can enable it after review. */
export function memoryDraftFromBackup(backup: MemoryBackup): { notes: string; enabled: false } {
  const parsed = envelopeSchema.parse(backup);
  return { notes: parsed.memory.notes, enabled: false };
}
