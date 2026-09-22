'use client';
import './memory-backup.css';
import { useEffect, useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { exportMemoryBackup, memoryDraftFromBackup, readMemoryBackupFile, type MemoryBackup as Backup } from '@/lib/memory-backup';

export function MemoryBackup({ notes, enabled, draft, busy, open, onPending, onUse }: { notes: string; enabled: boolean; draft: boolean; busy: boolean; open: boolean; onPending: (pending: boolean) => void; onUse: (draft: { notes: string; enabled: false }) => void }) {
  const [incoming, setIncoming] = useState<Backup | null>(null), [filename, setFilename] = useState('');
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const version = useRef(0), file = useRef<HTMLInputElement>(null);
  function clear() { version.current++; setIncoming(null); setLoading(false); setFilename(''); setError(''); onPending(false); }
  useEffect(() => { clear(); }, [open]);
  useEffect(() => () => { version.current++; }, []);
  async function read(selected?: File) {
    if (!selected || busy) return;
    const request = ++version.current; setLoading(true); setIncoming(null); setError(''); onPending(true);
    setFilename(selected.name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 255));
    try { const backup = await readMemoryBackupFile(selected); if (request === version.current) setIncoming(backup); }
    catch (cause) { if (request === version.current) { setError(cause instanceof Error ? cause.message : 'Could not read this memory backup.'); onPending(false); } }
    finally { if (request === version.current) setLoading(false); }
  }
  function download() {
    try {
      const url = URL.createObjectURL(new Blob([exportMemoryBackup({ notes, enabled })], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'trio-personal-memory-' + new Date().toISOString().slice(0, 10) + '.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setError(''); toast.success(draft ? 'Memory draft downloaded; account unchanged' : 'Personal memory backup downloaded');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create this memory backup.'); }
  }
  return <section className="memory-suggest memory-backup"><h3>Back up personal memory</h3><p>Conversation backups contain memory used in past answers. Download these current notes and their setting separately. The file is unencrypted; keep it private. Do not put passwords or API keys in your notes.</p>
    <div className="dialog-actions"><button className="subtle-button" disabled={busy || loading} onClick={download}><Download size={15} />{draft ? 'Download memory draft' : 'Download memory'}</button><button className="subtle-button" disabled={busy || loading} onClick={() => file.current?.click()}><Upload size={15} />Choose memory backup</button></div>
    <input ref={file} type="file" hidden accept="application/json,.json" aria-label="Choose personal memory backup" onChange={event => { void read(event.target.files?.[0]); event.target.value = ''; }} />
    <small>Restore a Trio personal memory JSON file under 32 KB. Choosing a file does not change your notes or contact a model.</small>
    {loading && <p role="status">Reading memory backup… <button className="subtle-button" onClick={clear}>Cancel reading</button></p>}
    {error && <div className="error-box" role="alert">{error}</div>}
    {incoming && <div className="memory-import-preview"><h4>Review memory backup</h4><p className="memory-import-filename">{filename}</p><small>Exported {incoming.exportedAt.slice(0, 10)} · {incoming.memory.notes.length.toLocaleString()} characters · Memory was {incoming.memory.enabled ? 'on' : 'off'} when exported.</small>
      <label className="memory-editor">Notes in backup<textarea aria-label="Notes in memory backup" readOnly value={incoming.memory.notes} placeholder="This backup has empty notes." /></label>
      <p>This replaces the current notes draft and sets Use personal memory to off. Review the imported text above, then choose whether to enable it and Save memory. Your saved account stays unchanged until you save.</p>
      <div className="dialog-actions"><button className="subtle-button" disabled={busy} onClick={clear}>Cancel memory import</button><button className="subtle-button" disabled={busy} onClick={() => { if (!incoming || busy) return; onUse(memoryDraftFromBackup(incoming)); clear(); }}>Replace draft with imported notes</button></div>
    </div>}
  </section>;
}
