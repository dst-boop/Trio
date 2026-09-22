import { emptyMemory, memoryProfileSchema, type MemoryProfile } from './memory.ts';

export async function readMemory(db: D1Database, userId: string): Promise<MemoryProfile> {
  const row = await db.prepare('SELECT revision, enabled, notes FROM personal_memory WHERE user_id = ?').bind(userId).first<{ revision: number; enabled: number; notes: string }>();
  return row ? memoryProfileSchema.parse({ ...row, enabled: Boolean(row.enabled) }) : { ...emptyMemory };
}

export async function writeMemory(db: D1Database, userId: string, profile: MemoryProfile): Promise<boolean> {
  const input = memoryProfileSchema.parse(profile);
  const result = await db.batch<{ revision: number; enabled: number; notes: string }>([
    db.prepare("INSERT INTO personal_memory (user_id, revision, enabled, notes) VALUES (?, 0, 0, '') ON CONFLICT(user_id) DO NOTHING").bind(userId),
    db.prepare('UPDATE personal_memory SET revision = revision + 1, enabled = ?, notes = ? WHERE user_id = ? AND revision = ?').bind(Number(input.enabled), input.notes, userId, input.revision),
    db.prepare('SELECT revision, enabled, notes FROM personal_memory WHERE user_id = ?').bind(userId),
  ]);
  const saved = result[2].results[0];
  // Repeating an identical intent after a lost response is safe; changed notes
  // or a later revision still conflict, including after a deletion.
  return saved?.revision === input.revision + 1 && saved.enabled === Number(input.enabled) && saved.notes === input.notes;
}
