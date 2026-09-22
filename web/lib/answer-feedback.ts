import { answerFeedbackSchema, serializeSessions, type AnswerFeedback, type Session } from './sessions.ts';
export type { AnswerFeedback } from './sessions.ts';

/** Update one completed answer without changing its content or other conversations. */
export function setAnswerFeedback(sessions: Session[], sessionId: string, index: number, feedback: AnswerFeedback | null): Session[] {
  const source = sessions.find(s => s.id === sessionId), turn = source?.turns[index];
  if (!Number.isInteger(index) || !turn || turn.result.demo || !(turn.result.answer || Object.values(turn.result.drafts).some(Boolean))) throw new Error('Choose a completed live answer to give feedback.');
  const parsed = feedback === null ? undefined : answerFeedbackSchema.parse(feedback);
  const updated = sessions.map(s => s.id !== sessionId ? s : { ...s, turns: s.turns.map((t, i) => {
    if (i !== index) return t;
    const { feedback: previous, ...rest } = t;
    return parsed ? { ...rest, feedback: parsed } : rest;
  }) });
  serializeSessions(updated); // Reject an over-capacity edit before changing the UI.
  return updated;
}
