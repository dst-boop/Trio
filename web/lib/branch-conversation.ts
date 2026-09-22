import { sessionSchema, serializeSessions, type Session } from './sessions.ts';
import { maxSessionTitle } from './session-library.ts';

/** Copy completed turns through the chosen answer; never mutate or evict the source. */
export function branchConversation(sessions: Session[], sourceId: string, turnIndex: number, title: string, id = crypto.randomUUID(), time = new Date().toISOString()): { session: Session; sessions: Session[] } {
  const source = sessions.find(s => s.id === sourceId);
  if (!source || !Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex >= source.turns.length) throw new Error('Choose an answer from a saved conversation.');
  if (sessions.length >= 30) throw new Error('Your workspace has 30 conversations. Export and remove one before creating another.');
  if (!title.trim() || title.trim().length > maxSessionTitle) throw new Error(`Use a conversation name between 1 and ${maxSessionTitle} characters.`);
  if (sessions.some(s => s.id === id)) throw new Error('Could not create a separate conversation. Try again.');
  const session = sessionSchema.parse({ id, title: title.trim(), time, instructions: source.turns[turnIndex].instructions ?? '', turns: source.turns.slice(0, turnIndex + 1) });
  const next = [session, ...sessions];
  try { serializeSessions(next); } catch { throw new Error('This copy would exceed your workspace storage limit. Export and remove older conversations first.'); }
  return { session, sessions: next };
}
