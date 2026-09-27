'use client';
import type { MouseEvent } from 'react';
import { Archive, Settings2, Check, Layers3, GitCompareArrows, ShieldCheck, ChevronRight, Lightbulb, CircleHelp, Trash2 } from 'lucide-react';
import { Sidebar, SidebarContent, SidebarHeader, SidebarFooter } from '@/components/ui/sidebar';
import { SessionList } from '@/components/session-library';
import { NewSessionButton } from '@/components/draft-navigation';
import type { Session } from '@/lib/sessions';
import type { SessionAction } from '@/components/session-library';
import type { DraftDestination } from '@/components/draft-navigation';

export type WorkspacePanel = 'quality' | 'comparison' | 'work' | 'settings' | 'memory' | 'backups' | 'help' | 'clearHistory';
type Props = {
  account?: { displayName: string; email: string }; busy: boolean; status: string;
  openActions: number; connected: number; memoryStatus: string;
  sessions: Session[]; current: string | null; query: string; onQuery: (query: string) => void;
  onNavigate: (destination: DraftDestination) => void; onSessionAction: (action: SessionAction) => void; onExport: (session: Session) => void;
  onOpen: (panel: WorkspacePanel) => void; onFocusComposer: () => void; onSignOut: (event: MouseEvent<HTMLAnchorElement>) => void;
};

export function WorkspaceSidebar({ account, busy, status, openActions, connected, memoryStatus, sessions, current, query, onQuery, onNavigate, onSessionAction, onExport, onOpen, onFocusComposer, onSignOut }: Props) {
  const initial = (account?.displayName.trim()[0] ?? 'G').toUpperCase();
  return <Sidebar className="trio-sidebar">
      <SidebarHeader className="brand"><span className="brand-symbol">◈</span><span>trio<span className="brand-period">.</span></span><span className="brand-caption">WORKSPACE</span></SidebarHeader>
      <SidebarContent className="side-content">
        <NewSessionButton busy={busy} onRequest={() => onNavigate({ type: 'new' })} />
        <div className="side-label">YOUR WORKSPACE</div>
        {account && <button className="side-nav" disabled={busy} onClick={() => onOpen('quality')}><GitCompareArrows size={17} />Quality check</button>}
        {account && <button className="side-nav" disabled={busy} onClick={() => onOpen('comparison')}><GitCompareArrows size={17} />Compare on your work</button>}
        <button className="side-nav" disabled={busy} onClick={() => onOpen('work')}><Check size={17} />Your work<span className="nav-count">{openActions}</span></button>
        <button className="side-nav selected" onClick={() => onFocusComposer()}><Layers3 size={17} /> Conversations</button>
        <button className="side-nav" onClick={() => onOpen('settings')}><Settings2 size={17} /> Model connections <span className="nav-count">{connected}/3</span></button>
        {account && <button className="side-nav" disabled={busy} onClick={() => onOpen('memory')}><Lightbulb size={17} />Personal memory<span className="nav-count">{memoryStatus}</span></button>}
        <button className="side-nav" disabled={busy} onClick={() => onOpen('backups')}><Archive size={17} />Back up & restore</button>
        <div className="history-heading"><span className="side-label">RECENT SESSIONS</span>{sessions.length > 0 && <button aria-label="Clear session history" disabled={busy} onClick={() => onOpen('clearHistory')}><Trash2 size={14} /></button>}</div>
        <SessionList sessions={sessions} current={current} busy={busy} query={query} onQuery={onQuery} onSelect={s => onNavigate({ type: 'session', id: s.id })} onAction={onSessionAction} onExport={onExport} />
        <button className="workspace-help" onClick={() => onOpen('help')}><CircleHelp size={16} />How Trio works<ChevronRight size={14} /></button>
      </SidebarContent>
      <SidebarFooter className="sidebar-foot"><span className="avatar" aria-hidden="true">{initial}</span><div title={account?.email}>{account?.displayName ?? "Guest workspace"}<small><ShieldCheck size={12} /> {account ? status : "Stored on this device"}</small>{account ? <a href="/signout-with-chatgpt?return_to=%2F" onClick={onSignOut}>Sign out</a> : <a href="/signin-with-chatgpt?return_to=%2Fworkspace">Sign in to save online</a>}</div><button aria-label="About Trio" onClick={() => onOpen('help')}><CircleHelp size={17} /></button></SidebarFooter>
    </Sidebar>;
}
