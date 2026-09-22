import { z } from 'zod';
import { sessionSchema, serializeSessions, type Session } from './sessions.ts';

export const maxBackupBytes = 20_000_000;
const records = z.array(sessionSchema).min(1).max(30).refine(sessions => new Set(sessions.map(s => s.id)).size === sessions.length);
const envelope = z.object({ format: z.literal('trio-workspace'), version: z.literal(1), exportedAt: z.string().datetime(), sessions: records });
const byteLength = (value: string) => new TextEncoder().encode(value).length;

/** A portable backup is deliberately independent of the smaller localStorage budget. */
export function exportBackup(sessions: Session[]): string {
  const parsed = records.safeParse(sessions);
  if (!parsed.success) throw new Error('These sessions could not be backed up. Export individual conversations as Markdown.');
  const text = JSON.stringify({ format: 'trio-workspace', version: 1, exportedAt: new Date().toISOString(), sessions: parsed.data });
  if (byteLength(text) > maxBackupBytes) throw new Error('This backup exceeds 20 MB. Export individual conversations as Markdown.');
  return text;
}

/** All-or-nothing validation. Never silently discard damaged or unsupported records. */
export function parseBackup(text: string): Session[] {
  if (text.length > maxBackupBytes || byteLength(text) > maxBackupBytes) throw new Error('Choose a Trio backup under 20 MB.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('This file is not valid JSON. Choose a Trio workspace backup.'); }
  const parsed = envelope.safeParse(value);
  if (!parsed.success) throw new Error('This is not a supported Trio backup, or a session is damaged. Nothing was imported.');
  return parsed.data.sessions;
}

export async function readBackupFile(file: Pick<File, 'size' | 'text'>): Promise<Session[]> {
  if (file.size > maxBackupBytes) throw new Error('Choose a Trio backup under 20 MB.');
  let text: string;
  try { text = await file.text(); } catch { throw new Error('The backup could not be read. Choose the file again.'); }
  return parseBackup(text);
}

export type ImportPlan = { sessions: Session[]; added: number; skipped: number; copies: number; overCapacity: boolean; fitsLocalHistory: boolean };

/** Preserve existing order and records. Reimporting the same content is idempotent. */
export function planImport(existing: Session[], incoming: Session[]): ImportPlan {
  const sessions = [...existing], ids = new Set(existing.map(s => s.id));
  // Time and identity can differ across devices while the actual conversation is identical.
  const fingerprint = (s: Session) => { const parsed = sessionSchema.safeParse(s); const normalized = parsed.success ? parsed.data : s; return JSON.stringify({ title: normalized.title, instructions: normalized.instructions ?? '', turns: normalized.turns }); };
  const seen = new Set(existing.map(fingerprint));
  let added = 0, skipped = 0, copies = 0;
  for (const candidate of incoming) {
    const key = fingerprint(candidate);
    if (seen.has(key)) { skipped++; continue; }
    let id = candidate.id;
    if (ids.has(id)) {
      copies++; let suffix = 1;
      do { id = candidate.id.slice(0, 80) + '-copy-' + suffix++; } while (ids.has(id));
    }
    sessions.push({ ...candidate, id }); ids.add(id); seen.add(key); added++;
  }
  let fitsLocalHistory = true;
  try { serializeSessions(sessions); } catch { fitsLocalHistory = false; }
  return { sessions, added, skipped, copies, overCapacity: sessions.length > 30, fitsLocalHistory };
}

export function mergeBackup(existing: Session[], incoming: Session[]): ImportPlan {
  const plan = planImport(existing, incoming);
  if (plan.overCapacity) throw new Error('This would exceed 30 sessions. Select fewer conversations to import.');
  return plan;
}
