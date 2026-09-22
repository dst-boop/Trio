import { z } from 'zod';
import { sessionSchema, serializeSessions, type Session } from './sessions.ts';

export const workspaceSchema = z.object({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), sessions: z.array(sessionSchema).max(30) }).strict();
export type WorkspaceSnapshot = { revision: number; sessions: Session[] };

/** One SQL read sees one committed version, including all of its chunks. */
export async function readWorkspace(db: D1Database, userId: string): Promise<WorkspaceSnapshot> {
  const rows = await db.prepare('SELECT w.revision, c.position, c.content FROM workspaces w LEFT JOIN workspace_chunks c ON c.user_id = w.user_id WHERE w.user_id = ? ORDER BY c.position').bind(userId).all<{ revision: number; position: number | null; content: string | null }>();
  if (!rows.results.length) return { revision: 0, sessions: [] };
  const raw = rows.results.map(r => r.content ?? '').join('') || '[]';
  return workspaceSchema.parse({ revision: rows.results[0].revision, sessions: JSON.parse(raw) });
}

/** Compare-and-swap and replacement share a transaction. Stale tabs cannot overwrite. */
export async function writeWorkspace(db: D1Database, userId: string, input: WorkspaceSnapshot): Promise<boolean> {
  const parsed = workspaceSchema.parse(input);
  const snapshot = serializeSessions(parsed.sessions);
  const token = crypto.randomUUID();
  const statements = [
    db.prepare('INSERT INTO workspaces (user_id, revision, token) VALUES (?, 0, ?) ON CONFLICT(user_id) DO NOTHING').bind(userId, ''),
    db.prepare('UPDATE workspaces SET revision = revision + 1, token = ? WHERE user_id = ? AND revision = ?').bind(token, userId, parsed.revision),
    db.prepare('DELETE FROM workspace_chunks WHERE user_id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE user_id = ? AND token = ?)').bind(userId, userId, token),
  ];
  let position = 0;
  for (let start = 0; start < snapshot.length;) {
    let end = Math.min(start + 250_000, snapshot.length);
    if (end < snapshot.length && /[\uD800-\uDBFF]/.test(snapshot[end - 1])) end--;
    statements.push(db.prepare('INSERT INTO workspace_chunks (user_id, position, content) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM workspaces WHERE user_id = ? AND token = ?)').bind(userId, position++, snapshot.slice(start, end), userId, token));
    start = end;
  }
  const results = await db.batch(statements);
  return results[1].meta.changes === 1;
}
