'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { Switch } from '@/components/ui/switch';
import { memoryProfileSchema, maxMemoryCharacters, type MemoryProfile } from '@/lib/memory';
import { providers, type Connections, type ProviderId } from '@/lib/trio';
import { toast } from 'sonner';
import { MemoryBackup } from '@/components/memory-backup';

async function decoded(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(z.object({ error: z.string() }).safeParse(data).data?.error ?? 'Personal memory is unavailable.');
  return data;
}
export function usePersonalMemory(accountId?: string) {
  const [profile, setProfile] = useState<MemoryProfile | null>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(accountId));
  const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!accountId) return;
    const version = ++generation.current; setLoading(true); setError('');
    try { const result = memoryProfileSchema.parse(await decoded(await fetch('/api/memory', { headers: { 'X-Trio-Account': accountId }, cache: 'no-store', signal: AbortSignal.timeout(30_000) }))); if (version === generation.current) setProfile(result); }
    catch { if (version === generation.current) { setProfile(null); setError('Personal memory could not be loaded. Retry before starting a live answer.'); } }
    finally { if (version === generation.current) setLoading(false); }
  }, [accountId]);
  useEffect(() => { setProfile(null); void reload(); return () => { generation.current++; }; }, [reload]);
  const save = async (input: MemoryProfile) => {
    if (!accountId) throw new Error('Sign in to save memory.');
    const version = generation.current;
    const result = memoryProfileSchema.parse(await decoded(await fetch('/api/memory', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Trio-Account': accountId }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) })));
    if (version === generation.current) { setProfile(result); setError(''); }
  };
  return { profile, error, loading, reload, save };
}
type MemoryState = ReturnType<typeof usePersonalMemory>;
export function PersonalMemory({ accountId, open, onOpenChange, memory, connections, sessionId, sessionSaved, busy }: { accountId: string; open: boolean; onOpenChange: (open: boolean) => void; memory: MemoryState; connections: Connections; sessionId: string | null; sessionSaved: boolean; busy: boolean }) {
  const [notes, setNotes] = useState(''), [enabled, setEnabled] = useState(false), [error, setError] = useState('');
  const [saving, setSaving] = useState(false), [suggesting, setSuggesting] = useState(false), [suggested, setSuggested] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [importPending, setImportPending] = useState(false), [imported, setImported] = useState(false);
  const [chosen, setChosen] = useState<ProviderId>('claude');
  const abort = useRef<AbortController | null>(null), version = useRef(0);
  const available = providers.filter(p => connections[p.id].enabled && connections[p.id].key.trim());
  const provider = available.find(p => p.id === chosen)?.id ?? available[0]?.id;
  const edited = Boolean(memory.profile && (notes !== memory.profile.notes || enabled !== memory.profile.enabled));
  const dirty = edited || importPending;
  useEffect(() => { version.current++; abort.current?.abort(); setSuggesting(false); setNotes(memory.profile?.notes ?? ''); setEnabled(memory.profile?.enabled ?? false); setError(''); setSuggested(false); setImported(false); setImportPending(false); setDiscardOpen(false); }, [open, memory.profile]);
  useEffect(() => () => { version.current++; abort.current?.abort(); }, []);
  useEffect(() => {
    if (!open || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [open, dirty]);
  function changeOpen(value: boolean) {
    if (saving) return;
    if (!value) {
      // Stop a pending suggestion before deciding whether to discard the draft.
      // A late response must not replace notes while the confirmation is open.
      version.current++; abort.current?.abort(); setSuggesting(false);
      if (dirty) { setDiscardOpen(true); return; }
    }
    onOpenChange(value);
  }
  async function save(forget = false) {
    if (!memory.profile || saving || suggesting || busy || importPending) return;
    if (forget && !window.confirm('Forget personal memory for future answers? Earlier answer snapshots and downloaded backups are retained.')) return;
    setSaving(true); setError('');
    try { await memory.save({ revision: memory.profile.revision, notes: forget ? '' : notes.trim(), enabled: forget ? false : enabled }); toast.success(forget ? 'Personal memory forgotten' : 'Personal memory saved'); onOpenChange(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save memory.'); }
    finally { setSaving(false); }
  }
  async function suggest() {
    if (!provider || !sessionId || !sessionSaved || busy || suggesting || saving || importPending) return;
    if (notes !== memory.profile?.notes && !window.confirm('Replace the current draft with suggested memory? Save or copy your edits first.')) return;
    const request = ++version.current; const controller = new AbortController(); abort.current = controller;
    setSuggesting(true); setError('');
    try {
      const data = z.object({ suggestion: z.string().max(maxMemoryCharacters) }).parse(await decoded(await fetch('/api/memory/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trio-Account': accountId }, signal: controller.signal, body: JSON.stringify({ sessionId, connection: { provider, key: connections[provider].key, model: connections[provider].model } }) })));
      if (request === version.current) { setNotes(data.suggestion); setSuggested(true); }
    } catch (e) { if (request === version.current && !controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not suggest memory.'); }
    finally { if (request === version.current) setSuggesting(false); }
  }
  return <Dialog open={open} onOpenChange={changeOpen}><DialogContent className="memory-dialog"><DialogTitle>Personal memory</DialogTitle><DialogDescription>Keep useful goals, background, and preferences in your private account. You decide what Trio remembers. This provides context to your models; it does not train their weights or guarantee accuracy.</DialogDescription>
    {memory.loading ? <p role="status">Loading personal memory…</p> : !memory.profile ? <div role="alert"><p>{memory.error}</p><button className="subtle-button" onClick={() => void memory.reload()}>Retry loading memory</button></div> : <>
      <div className="connection-mode"><div><strong>Use personal memory</strong><p>When enabled, saved notes go to every participating model in future live questions. Demo ignores memory.</p></div><Switch aria-label="Use personal memory" checked={enabled} disabled={busy || saving || suggesting} onCheckedChange={setEnabled} /></div>
      <label className="memory-editor">What should Trio remember?<textarea aria-label="Personal memory notes" value={notes} maxLength={maxMemoryCharacters} disabled={busy || saving || suggesting} onChange={e => { setNotes(e.target.value); setSuggested(false); }} placeholder="For example: I prefer plain-language explanations, practical examples, and a short list of next steps." /><small>{notes.length.toLocaleString()} / 4,000 characters. Avoid passwords, API keys, and sensitive personal details.</small></label>
      {suggested && <p className="revision-note" role="status">Suggested draft — not saved. Check every note, remove guesses, and save only what you want remembered.</p>}
      {imported && <p className="revision-note" role="status">Imported draft — not saved. Review your notes and the Use personal memory setting, then Save memory to update your account.</p>}
      <MemoryBackup key={memory.profile.revision} notes={notes} enabled={enabled} draft={edited} busy={busy || saving || suggesting} open={open} onPending={setImportPending} onUse={draft => { setNotes(draft.notes); setEnabled(draft.enabled); setSuggested(false); setImported(true); setError(''); }} />
      <section className="memory-suggest"><h3>Learn from this conversation</h3><p>Send up to six recent live question-and-answer pairs from the currently open, saved conversation, including any feedback you recorded on those answers, plus your existing memory, to one connected model. One API request is billed by that provider. Nothing is remembered automatically.</p><label>Model for suggestions<select aria-label="Model for memory suggestions" value={provider ?? ''} disabled={busy || suggesting || saving || !available.length} onChange={e => setChosen(e.target.value as ProviderId)}>{!available.length && <option value="">Connect a model first</option>}{available.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button className="subtle-button" disabled={busy || saving || suggesting || importPending || !provider || !sessionId || !sessionSaved} onClick={() => void suggest()}>Suggest from conversation</button>{suggesting && <button className="subtle-button" onClick={() => { version.current++; abort.current?.abort(); setSuggesting(false); }}>Stop suggestion</button>}{(!sessionId || !sessionSaved) && <small>Open a conversation and wait for it to finish saving first.</small>}</section>
      {error && <div className="error-box" role="alert"><p>{error}</p><button className="subtle-button" disabled={saving || suggesting} onClick={() => { if (window.confirm('Discard this memory draft and load the latest saved memory? Copy edits you want to keep first.')) void memory.reload(); }}>Reload saved memory</button></div>}
      <div className="dialog-actions"><button className="subtle-button" disabled={busy || saving || suggesting || importPending || !memory.profile.notes} onClick={() => void save(true)}>Forget memory</button><button className="run-button" disabled={busy || saving || suggesting || importPending} onClick={() => void save()}>{saving ? 'Saving…' : 'Save memory'}</button></div><small>Forgetting clears future personalization. Earlier answers retain the memory they used; delete those conversations separately if needed.</small>
    </>}
    <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}><AlertDialogContent><AlertDialogTitle>Discard unsaved memory changes?</AlertDialogTitle><AlertDialogDescription>Your edited notes, selected backup, suggested draft, and memory setting have not been saved. Keep editing to review and save them, or discard these changes. Your saved personal memory will stay as it is.</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => { setDiscardOpen(false); onOpenChange(false); }}>Discard changes</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </DialogContent></Dialog>;
}
