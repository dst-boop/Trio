import type { conversationContext } from '@/lib/sessions';

export function FollowUpContext({ context }: { context: ReturnType<typeof conversationContext> }) {
  const { includedTurns, omittedTurns, shortenedAnswers } = context;
  return <details className="followup-context"><summary>{includedTurns ? `Next question uses ${includedTurns} of ${includedTurns + omittedTurns} earlier live answers` : 'No earlier live answers included'}{shortenedAnswers > 0 && ' · shortened excerpts'}</summary><p>Trio includes your latest six completed live question-and-answer pairs. Demo examples are excluded. {omittedTurns > 0 && `${omittedTurns} older ${omittedTurns === 1 ? 'exchange is' : 'exchanges are'} outside this context window. `}{shortenedAnswers > 0 && `${shortenedAnswers} ${shortenedAnswers === 1 ? 'answer is' : 'answers are'} shortened to fit; each Compare perspective keeps a share of the space. `}Saved history and exports keep the full answers. Repeat any older detail needed for this question, or use Session instructions for an ongoing requirement. Earlier image and PDF files are not part of this text history; attach needed files to the current question.</p></details>;
}
