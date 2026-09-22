'use client';

import { Component, lazy, Suspense, type ReactNode } from 'react';

const FormattedAnswer = lazy(() => import('./answer-renderer').then(module => ({ default: module.Answer })));

function PlainAnswer({ text, failed = false }: { text: string; failed?: boolean }) {
  return <div className="prose-answer"><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</div>{failed && <p className="revision-note">Answer formatting is unavailable. You can still read and copy the full text.</p>}</div>;
}

class FormattingBoundary extends Component<{ children: ReactNode; text: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <PlainAnswer text={this.props.text} failed /> : this.props.children; }
}

/** Load Markdown only when an answer exists. Plain text remains readable if its chunk fails. */
export function Answer({ text }: { text: string }) {
  if (!text) return null;
  return <FormattingBoundary text={text}><Suspense fallback={<PlainAnswer text={text} />}><FormattedAnswer text={text} /></Suspense></FormattingBoundary>;
}
