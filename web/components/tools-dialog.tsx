'use client';
import { AudioLines, ImagePlus } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { PreferencesStatus } from '@/components/preferences-status';
import { WorkflowBriefs } from '@/components/workflow-briefs';
import { FollowUpContext } from '@/components/follow-up-context';
import { SessionInstructions } from '@/components/session-instructions';
import { toast } from 'sonner';
import type { ResearchChoice } from '@/lib/research';
import type { conversationContext } from '@/lib/sessions';
import type { Mode } from '@/lib/trio';
import type { useWorkspacePreferences } from '@/components/use-workspace-preferences';

type Props = {
  open: boolean; onOpenChange: (open: boolean) => void; onRestoreFocus: () => void;
  busy: boolean; demo: boolean; temporaryDemo: boolean; mode: Mode; attachmentsLoading: boolean;
  onMedia: (tool: 'audio' | 'image') => void;
  /** Earlier turns sent with a follow-up, or null for a new conversation. */
  followUp: ReturnType<typeof conversationContext> | null;
  sessionKey: string; instructions: string; onInstructions: (value: string) => void;
  webResearch: boolean; onWebResearch: (value: boolean) => void; researchProvider: ResearchChoice; onResearchProvider: (choice: ResearchChoice) => void;
  preferences: ReturnType<typeof useWorkspacePreferences>; prompt: string; onApplyBrief: (text: string) => void;
};

/** Optional inputs for the next question: media tools, instructions, web research and guided briefs. */
export function ToolsDialog({ open, onOpenChange, onRestoreFocus, busy, demo, temporaryDemo, mode, attachmentsLoading, onMedia, followUp, sessionKey, instructions, onInstructions, webResearch, onWebResearch, researchProvider, onResearchProvider, preferences, prompt, onApplyBrief }: Props) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="tools-dialog" onCloseAutoFocus={event => { event.preventDefault(); onRestoreFocus(); }}><DialogTitle>Tools &amp; context</DialogTitle><DialogDescription>Add source material, instructions, research, or a guided work brief.</DialogDescription>        <div className="question-options">
        <div className="creation-tools"><button className="attach-button" disabled={busy} onClick={() => { onOpenChange(false); onMedia('audio'); }} title="Review a recording as text before asking Trio"><AudioLines size={17} /><span>Audio to text</span></button><button className="attach-button" disabled={busy || attachmentsLoading} onClick={() => { onOpenChange(false); onMedia('image'); }}><ImagePlus size={17} /><span>Create image</span></button></div>
        {!demo && followUp && <FollowUpContext context={followUp} />}
        <SessionInstructions key={sessionKey} value={instructions} busy={busy} demo={demo} onChange={onInstructions} />
        <section className="research-setting"><div><label htmlFor="web-research">Web research</label><p>{mode === 'single' ? 'OpenAI or Claude searches first. Your answer uses the cited brief.' : 'OpenAI or Claude searches first. Every model receives the same cited brief.'}</p><small>{demo ? 'Available in Live mode. Demo never searches.' : 'Adds up to two API calls; search fees apply.'}</small></div><div className="research-controls">{webResearch && !demo && <label>Research provider<select aria-label="Research provider" value={researchProvider} disabled={busy} onChange={e => onResearchProvider(e.target.value as ResearchChoice)}><option value="auto">Automatic · OpenAI, then Claude</option><option value="openai">OpenAI</option><option value="claude">Claude</option></select></label>}<Switch id="web-research" aria-label="Web research" checked={webResearch} onCheckedChange={onWebResearch} disabled={busy || demo} /></div></section>
        </div>
        <details className="question-options"><summary>Guided workflows</summary><WorkflowBriefs busy={busy || preferences.loading} prompt={prompt} onApply={text => { onOpenChange(false); onApplyBrief(text); toast('Brief prepared and Live mode selected. Review your model choices, then choose Ask Trio.'); }} /></details><PreferencesStatus preferences={preferences} busy={busy} temporaryDemo={temporaryDemo} /><button className="run-button" onClick={() => onOpenChange(false)}>Done</button></DialogContent></Dialog>;
}
