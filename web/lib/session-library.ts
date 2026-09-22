import type { Session } from './sessions.ts';

export const maxSessionTitle = 120;

/** Search only saved conversation content; connection state and attachment bytes are absent. */
export function searchSessions(sessions: Session[], query: string): Session[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return sessions;
  return sessions.filter(session => {
    const text = [session.title, session.instructions, ...session.turns.flatMap(turn => [turn.question, turn.instructions, turn.imageName, turn.pdfName, turn.result.answer, ...turn.result.errors, ...Object.values(turn.result.drafts), ...Object.values(turn.result.reviews), ...Object.values(turn.result.revisions ?? {}), turn.result.research?.text, ...(turn.result.research?.sources ?? []).flatMap(source => [source.title, source.url])])].filter(Boolean).join('\n').toLowerCase();
    return terms.every(term => text.includes(term));
  });
}

export function renameSession(sessions: Session[], id: string, title: string): Session[] {
  const name = title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!name || name.length > maxSessionTitle) throw new Error('Choose a session name between 1 and 120 characters.');
  if (!sessions.some(session => session.id === id)) throw new Error('This session is no longer available.');
  return sessions.map(session => session.id === id ? { ...session, title: name } : session);
}
