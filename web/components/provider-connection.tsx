'use client';

import { useEffect, useRef, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { connectionMessages, type ConnectionStatus } from '@/lib/connection-status';
import { providers, type Connections, type ProviderId } from '@/lib/trio';
import { savedKeyReference, workspaceKeyReference, type SavedConnection } from '@/lib/saved-connections';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';

export function ProviderConnection({ id, connection, disabled, open, onChange, accountId, saved, workspace, saving, canSave, onSave, onRemove }: { id: ProviderId; connection: Connections[ProviderId]; disabled: boolean; open: boolean; onChange: (value: Connections[ProviderId]) => void; accountId?: string; saved?: SavedConnection; workspace?: boolean; saving?: boolean; canSave?: boolean; onSave?: () => void; onRemove?: () => void }) {
  const provider = providers.find(p => p.id === id)!;
  const [status, setStatus] = useState<ConnectionStatus | 'idle' | 'checking'>('idle');
  const active = useRef<AbortController | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const usingSaved = connection.key === savedKeyReference;
  const usingWorkspace = connection.key === workspaceKeyReference;
  const cancel = () => { active.current?.abort(); active.current = null; };
  useEffect(() => {
    setStatus('idle');
    return () => { active.current?.abort(); active.current = null; };
  }, [connection.key, connection.model, open]);
  const change = (value: Connections[ProviderId]) => { cancel(); setStatus('idle'); onChange(value); };
  async function check() {
    cancel(); const controller = new AbortController(); active.current = controller; setStatus('checking');
    const timeout = AbortSignal.timeout(20_000);
    try {
      const response = await fetch('/api/connections/check', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(accountId ? { 'X-Trio-Account': accountId } : {}) }, body: JSON.stringify({ provider: id, key: connection.key, model: connection.model }), signal: AbortSignal.any([controller.signal, timeout]) });
      const data = await response.json();
      if (active.current !== controller) return;
      const next = data && typeof data === 'object' && 'status' in data && typeof data.status === 'string' && Object.hasOwn(connectionMessages, data.status) ? data.status as ConnectionStatus : 'network';
      setStatus(response.ok || next !== 'checked' ? next : 'network');
    } catch { if (active.current === controller) setStatus(timeout.aborted ? 'timeout' : 'network'); }
    finally { if (active.current === controller) active.current = null; }
  }
  return <div className="connection-row">
    <div className="connection-header"><span className="model-mark small" style={{ color: provider.color }} aria-hidden="true">{provider.mark}</span><strong>{provider.name}</strong><a href={id === 'openai' ? 'https://platform.openai.com/api-keys' : id === 'claude' ? 'https://platform.claude.com/settings/keys' : 'https://aistudio.google.com/apikey'} target="_blank" rel="noopener noreferrer">Get API key ↗</a><Switch aria-label={`Enable ${provider.name}`} disabled={disabled} checked={connection.enabled} onCheckedChange={enabled => onChange({ ...connection, enabled })} /></div>
    <label>API key<input type="password" autoComplete="off" spellCheck={false} disabled={disabled} maxLength={1024} placeholder={usingSaved ? 'Saved securely · paste to replace' : usingWorkspace ? 'Included with Trio · paste to use your own key' : 'Paste your API key'} value={usingSaved || usingWorkspace ? '' : connection.key} onChange={e => change({ ...connection, key: e.target.value.trim() || (saved?.saved ? savedKeyReference : workspace ? workspaceKeyReference : '') })} /></label>
    <label>Model ID<input value={connection.model} disabled={disabled} maxLength={100} spellCheck={false} onChange={e => change({ ...connection, model: e.target.value.trim() })} /></label>
    <div className="connection-check"><span className={status === 'checked' ? 'access-checked' : ''}>{status === 'checked' ? 'Access checked' : status === 'checking' ? 'Checking access…' : usingWorkspace ? 'Included with Trio' : connection.key ? 'Key added · check access' : 'No key added'}</span>{status === 'checking' ? <button className="subtle-button" onClick={() => { cancel(); setStatus('cancelled'); }}>Cancel</button> : <button className="subtle-button" disabled={disabled || !connection.key || !connection.model} onClick={() => void check()}>Check access</button>}</div>
    {accountId && <div className="connection-check"><span>{saving ? 'Saving change…' : usingWorkspace ? 'Workspace connection · nothing to save' : usingSaved ? 'Saved to your account' : saved?.saved ? 'Replacement not saved' : 'Not saved to your account'}</span><button className="subtle-button" disabled={disabled || !canSave || !connection.key || usingWorkspace || !connection.model} onClick={onSave}>{usingSaved ? 'Save settings' : saved?.saved ? 'Save replacement' : 'Save to account'}</button>{saved?.saved && <button className="subtle-button" disabled={disabled || !canSave} onClick={() => setConfirmDelete(true)}>Delete saved key</button>}</div>}
    <p className="connection-feedback" role="status" aria-live="polite">{status === 'idle' ? usingWorkspace ? 'Trio provides this connection for the workspace — no API key needed. Paste your own key to use your provider account instead.' : usingSaved ? 'Your key is encrypted and available next time you sign in. It is never displayed here.' : accountId ? 'Save to account to remember this key. Unsaved keys disappear when you reload.' : 'Keys stay in this tab and are cleared when you reload.' : status === 'checking' ? 'Looking up model details. No answer is generated.' : connectionMessages[status]}</p>
    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}><AlertDialogContent><AlertDialogTitle>Delete saved {provider.name} key?</AlertDialogTitle><AlertDialogDescription>This removes the key from your Trio account and disconnects it in this tab. Requests already running may finish. It does not revoke the key with {provider.company}.</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>Keep key</AlertDialogCancel><AlertDialogAction disabled={disabled || !canSave} onClick={onRemove}>Delete saved key</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}
