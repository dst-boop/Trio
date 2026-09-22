'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { exportBackup, planImport, readBackupFile } from '@/lib/backups';
import { parseSessions, type Session } from '@/lib/sessions';

export function SessionBackups({ sessions, busy, remember, account = false, open, onOpenChange, onImport }: { account?: boolean; sessions: Session[]; busy: boolean; remember: boolean; open: boolean; onOpenChange: (open: boolean) => void; onImport: (sessions: Session[]) => void }) {
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [incoming, setIncoming] = useState<Session[]>([]), [selected, setSelected] = useState<string[]>([]), [filename, setFilename] = useState('');
  const fileRef = useRef<HTMLInputElement>(null), version = useRef(0);
  const chosen = useMemo(() => incoming.filter(s => selected.includes(s.id)), [incoming, selected]);
  const plan = useMemo(() => chosen.length ? planImport(sessions, chosen) : { sessions, added: 0, skipped: 0, copies: 0, overCapacity: false, fitsLocalHistory: true }, [sessions, chosen]);
  useEffect(() => () => { version.current++; }, []);
  useEffect(() => { version.current++; setLoading(false); setError(''); setIncoming([]); setSelected([]); setFilename(''); }, [open]);
  function changeOpen(value: boolean) {
    version.current++; onOpenChange(value);
  }
  async function read(file?: File) {
    if (!file || busy) return;
    const request = ++version.current;
    setLoading(true); setError(''); setIncoming([]); setSelected([]); setFilename(file.name);
    try { const sessions = await readBackupFile(file); if (request === version.current) { setIncoming(sessions); setSelected(sessions.map(s => s.id)); } }
    catch (error) { if (request === version.current) setError(error instanceof Error ? error.message : 'Could not read this backup.'); }
    finally { if (request === version.current) setLoading(false); }
  }
  function download() {
    try {
      const url = URL.createObjectURL(new Blob([exportBackup(sessions)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'trio-workspace-' + new Date().toISOString().slice(0, 10) + '.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('Workspace backup downloaded');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not create this backup.'); }
  }
  function restore() {
    if (busy || loading || !plan.added || plan.overCapacity || (account && !plan.fitsLocalHistory)) return;
    try { onImport(chosen); toast.success(`${plan.added} ${plan.added === 1 ? 'session' : 'sessions'} imported. Open one from Recent sessions.`); changeOpen(false); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not import this backup.'); }
  }
  return <Dialog open={open} onOpenChange={changeOpen}><DialogContent className="backup-dialog"><DialogTitle>Back up & restore</DialogTitle><DialogDescription>Move complete conversations between devices with a Trio JSON backup. Includes prompts, answers, session instructions, sources, and usage. API keys and original attachments are excluded.</DialogDescription>
      <section className="backup-export"><div><strong>{sessions.length} {sessions.length === 1 ? 'session' : 'sessions'} in this workspace</strong><p>Keep the downloaded file private. You can still export individual conversations as Markdown.</p></div><button className="subtle-button" disabled={busy || !sessions.length} onClick={download}><Download size={16} />Download backup</button></section>
      <section className="backup-import">{account && <div className="legacy-import"><h3>Bring sessions from this browser</h3><p>Only import conversations that belong to you. Nothing is uploaded until you confirm the selection below.</p><button className="subtle-button" disabled={busy || loading} onClick={() => { version.current++; setError(''); try { const old = parseSessions(localStorage.getItem('trio-sessions')); if (!old.length) throw new Error('No saved browser sessions were found.'); setIncoming(old); setSelected(old.map(s => s.id)); setFilename('Sessions saved on this browser'); } catch (e) { setError(e instanceof Error ? e.message : 'Could not read browser history.'); } }}>Preview browser sessions</button></div>}<h3>Restore from a backup</h3><p>Choose a Trio JSON file under 20 MB. Preview and select conversations before importing.</p><input ref={fileRef} type="file" accept="application/json,.json" aria-label="Choose workspace backup" hidden onChange={e => { void read(e.target.files?.[0]); e.target.value = ''; }} /><button className="subtle-button" disabled={busy || loading} onClick={() => fileRef.current?.click()}><Upload size={16} />{loading ? 'Reading backup…' : 'Choose backup'}</button>
      {loading && <p role="status">Reading and validating {filename}…</p>}
      {error && <div className="error-box" role="alert">{error}</div>}
      {!!incoming.length && <div className="backup-preview"><h4>{filename}</h4><div className="backup-selection-actions"><button onClick={() => setSelected(incoming.map(s => s.id))}>Select all</button><button onClick={() => setSelected([])}>Select none</button></div><div className="backup-session-list" aria-label="Conversations in backup">{incoming.map(s => <label key={s.id}><input type="checkbox" checked={selected.includes(s.id)} disabled={busy} onChange={e => setSelected(ids => e.target.checked ? [...ids, s.id] : ids.filter(id => id !== s.id))} /><span><strong>{s.title}</strong><small>{s.turns.length} {s.turns.length === 1 ? 'question' : 'questions'} · {s.turns.some(t => !t.result.demo) ? 'Live conversation' : 'Demo conversation'}</small></span></label>)}</div>
        <p className="backup-plan" role="status">{plan.added} new · {plan.skipped} already present{plan.copies ? ` · ${plan.copies} conflicting ${plan.copies === 1 ? 'version kept as a separate copy' : 'versions kept as separate copies'}` : ''}</p>
        {plan.overCapacity ? <p className="backup-warning" role="alert">This would create {plan.sessions.length} sessions. The limit is 30. Select fewer conversations, or back up and clear your existing history first.</p> : !plan.fitsLocalHistory ? <p className="backup-warning" role="alert">{account ? "This exceeds account history limits. Select fewer sessions to import." : "This exceeds local history limits. Imported sessions will stay in this tab only. Keep your backup before closing or refreshing."}</p> : !remember ? <p className="revision-note">Local history is off. Imported sessions will stay in this tab only. Enable “Remember sessions” in Connections to keep them on this device.</p> : <p className="revision-note">Imports join your existing history. Matching conversations are skipped; different versions are kept separately.</p>}
        <button className="run-button" disabled={busy || loading || !plan.added || plan.overCapacity || (account && !plan.fitsLocalHistory)} onClick={restore}>Import {plan.added} {plan.added === 1 ? 'session' : 'sessions'}<Upload size={15} /></button>
      </div>}</section>
    </DialogContent></Dialog>;
}
