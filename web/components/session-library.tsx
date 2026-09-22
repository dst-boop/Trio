'use client';

import { useEffect, useMemo, useState } from 'react';
import { MessageSquare, MoreHorizontal, Search, X, Pencil, Download, Trash2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { useSidebar } from '@/components/ui/sidebar';
import { searchSessions, maxSessionTitle } from '@/lib/session-library';
import type { Session } from '@/lib/sessions';

export type SessionAction = { type: 'rename' | 'delete'; id: string } | null;

export function SessionList({ sessions, current, busy, query, onQuery, onSelect, onAction, onExport }: { sessions: Session[]; current: string | null; busy: boolean; query: string; onQuery: (value: string) => void; onSelect: (session: Session) => void; onAction: (action: SessionAction) => void; onExport: (session: Session) => void }) {
  const matches = useMemo(() => searchSessions(sessions, query), [sessions, query]);
  const { setOpenMobile } = useSidebar();
  function action(type: 'rename' | 'delete', id: string) { setOpenMobile(false); onAction({ type, id }); }
  return <>
    {(sessions.length > 0 || query) && <div className="session-search"><Search size={14} aria-hidden="true" /><input aria-label="Search sessions" placeholder="Search conversations…" value={query} maxLength={200} onChange={event => onQuery(event.target.value)} />{query && <button aria-label="Clear session search" onClick={() => onQuery('')}><X size={14} /></button>}</div>}
    {query && <p className="session-search-count" role="status">{matches.length} of {sessions.length} sessions</p>}
    <div className="session-list">{matches.map(session => <div className="session-row" role="group" aria-label={`Session: ${session.title}`} key={session.id}>
      <button disabled={busy} className={`session-open ${session.id === current ? 'active' : ''}`} onClick={() => { onSelect(session); setOpenMobile(false); }} title={session.title}><MessageSquare size={15} /><span>{session.title}</span></button>
      <DropdownMenu><DropdownMenuTrigger asChild><button className="session-actions" disabled={busy} aria-label="Session actions" title={`Actions for ${session.title}`}><MoreHorizontal size={16} /></button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem disabled={busy} onSelect={() => action('rename', session.id)}><Pencil />Rename session</DropdownMenuItem><DropdownMenuItem disabled={busy} onSelect={() => onExport(session)}><Download />Export Markdown</DropdownMenuItem><DropdownMenuItem disabled={busy} variant="destructive" onSelect={() => action('delete', session.id)}><Trash2 />Delete session</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </div>)}{!matches.length && <p className="history-empty">{query ? 'No matching conversations. Try another word or clear the search.' : <>Good ideas start with a question.<br />Your sessions will appear here.</>}</p>}</div>
  </>;
}

/** Mounted outside the responsive sidebar so switching viewport or closing it preserves the dialog. */
export function SessionActionDialogs({ action, sessions, busy, clearsDraft = false, onClose, onRename, onDelete }: { action: SessionAction; sessions: Session[]; busy: boolean; clearsDraft?: boolean; onClose: () => void; onRename: (id: string, title: string) => void; onDelete: (id: string) => void }) {
  const session = sessions.find(s => s.id === action?.id);
  const titlePreview = session && session.title.length > 160 ? session.title.slice(0, 160) + '…' : session?.title;
  const [name, setName] = useState('');
  useEffect(() => { if (action?.type === 'rename') setName(session?.title ?? ''); }, [action, session?.title]);
  return <>
    <Dialog open={action?.type === 'rename' && !!session} onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="session-action-dialog"><DialogTitle>Rename session</DialogTitle><DialogDescription>Give this conversation a name you can find later. Its questions and answers stay intact.</DialogDescription><form onSubmit={event => { event.preventDefault(); if (session && !busy && name.trim() && name.trim().length <= maxSessionTitle) onRename(session.id, name); }}><label htmlFor="session-name">Session name</label><input id="session-name" aria-label="Session name" value={name} onChange={event => setName(event.target.value)} maxLength={maxSessionTitle} disabled={busy} autoComplete="off" /><small>{name.length} / {maxSessionTitle} characters</small><div className="dialog-actions"><button type="button" className="subtle-button" onClick={onClose}>Cancel</button><button className="run-button" type="submit" disabled={busy || !name.trim() || name.trim().length > maxSessionTitle}>Save name</button></div></form></DialogContent></Dialog>
    <AlertDialog open={action?.type === 'delete' && !!session} onOpenChange={open => { if (!open) onClose(); }}><AlertDialogContent className="session-action-dialog"><AlertDialogTitle>Delete this session?</AlertDialogTitle><AlertDialogDescription>This removes “{titlePreview}” and its {session?.turns.length} completed questions from this workspace’s saved history. Export it first if needed. Downloaded backups remain unchanged.{clearsDraft && ' Your current unsent question and attached files will also be cleared.'}</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>Keep session</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy} onClick={() => { if (session && !busy) onDelete(session.id); }}>Delete session</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>;
}
