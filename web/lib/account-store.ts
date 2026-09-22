import { z } from 'zod';
import { sessionSchema, serializeSessions, type Session } from './sessions.ts';

export const workspaceSchema = z.object({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), sessions: z.array(sessionSchema).max(30) }).strict();
export type WorkspaceSnapshot = { revision: number; sessions: Session[] };
export const workspaceWriteSchema = workspaceSchema.extend({ requestId: z.string().uuid().optional() });
type WorkspaceWrite = WorkspaceSnapshot & { requestId?: string };

/** One SQL read sees one committed version, including all of its chunks. */
export async function readWorkspace(db: D1Database, userId: string): Promise<WorkspaceSnapshot> {
  const rows = await db.prepare('SELECT w.revision, c.position, c.content FROM workspaces w LEFT JOIN workspace_chunks c ON c.user_id = w.user_id WHERE w.user_id = ? ORDER BY c.position').bind(userId).all<{ revision: number; position: number | null; content: string | null }>();
  if (!rows.results.length) return { revision: 0, sessions: [] };
  const raw = rows.results.map(r => r.content ?? '').join('') || '[]';
  return workspaceSchema.parse({ revision: rows.results[0].revision, sessions: JSON.parse(raw) });
}

/** Compare-and-swap and replacement share a transaction. Stale tabs cannot overwrite. */
export async function writeWorkspace(db: D1Database, userId: string, input: WorkspaceWrite): Promise<boolean> {
  const parsed = workspaceWriteSchema.parse(input);
  const snapshot = serializeSessions(parsed.sessions);
  // Bind retries to both their ID and validated content. Reusing an ID with new
  // content must never acknowledge or replace an earlier save at a stale revision.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot));
  const token = (parsed.requestId ?? crypto.randomUUID()) + ':' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const nextRevision = parsed.revision + 1;
  const statements = [
    db.prepare('INSERT INTO workspaces (user_id, revision, token) VALUES (?, 0, ?) ON CONFLICT(user_id) DO NOTHING').bind(userId, ''),
    db.prepare('UPDATE workspaces SET revision = revision + 1, token = ? WHERE user_id = ? AND revision = ?').bind(token, userId, parsed.revision),
    db.prepare('DELETE FROM workspace_chunks WHERE user_id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE user_id = ? AND token = ? AND revision = ?)').bind(userId, userId, token, nextRevision),
  ];
  let position = 0;
  for (let start = 0; start < snapshot.length;) {
    let end = Math.min(start + 250_000, snapshot.length);
    if (end < snapshot.length && /[\uD800-\uDBFF]/.test(snapshot[end - 1])) end--;
    statements.push(db.prepare('INSERT INTO workspace_chunks (user_id, position, content) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM workspaces WHERE user_id = ? AND token = ? AND revision = ?)').bind(userId, position++, snapshot.slice(start, end), userId, token, nextRevision));
    start = end;
  }
  statements.push(db.prepare('SELECT revision, token FROM workspaces WHERE user_id = ?').bind(userId));
  const results = await db.batch<{ revision: number; token: string }>(statements);
  const saved = results.at(-1)?.results[0];
  return saved?.revision === nextRevision && saved.token === token;
}
