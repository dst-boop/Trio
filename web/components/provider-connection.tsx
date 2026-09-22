'use client';

import { useEffect, useRef, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { connectionMessages, type ConnectionStatus } from '@/lib/connection-status';
import { providers, type Connections, type ProviderId } from '@/lib/trio';

export function ProviderConnection({ id, connection, disabled, open, onChange }: { id: ProviderId; connection: Connections[ProviderId]; disabled: boolean; open: boolean; onChange: (value: Connections[ProviderId]) => void }) {
  const provider = providers.find(p => p.id === id)!;
  const [status, setStatus] = useState<ConnectionStatus | 'idle' | 'checking'>('idle');
  const active = useRef<AbortController | null>(null);
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
      const response = await fetch('/api/connections/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: id, key: connection.key, model: connection.model }), signal: AbortSignal.any([controller.signal, timeout]) });
      const data = await response.json();
      if (active.current !== controller) return;
      const next = data && typeof data === 'object' && 'status' in data && typeof data.status === 'string' && Object.hasOwn(connectionMessages, data.status) ? data.status as ConnectionStatus : 'network';
      setStatus(response.ok || next !== 'checked' ? next : 'network');
    } catch { if (active.current === controller) setStatus(timeout.aborted ? 'timeout' : 'network'); }
    finally { if (active.current === controller) active.current = null; }
  }
  return <div className="connection-row">
    <div className="connection-header"><span className="model-mark small" style={{ color: provider.color }} aria-hidden="true">{provider.mark}</span><strong>{provider.name}</strong><a href={id === 'openai' ? 'https://platform.openai.com/api-keys' : id === 'claude' ? 'https://platform.claude.com/settings/keys' : 'https://aistudio.google.com/apikey'} target="_blank" rel="noopener noreferrer">Get API key ↗</a><Switch aria-label={`Enable ${provider.name}`} disabled={disabled} checked={connection.enabled} onCheckedChange={enabled => onChange({ ...connection, enabled })} /></div>
    <label>API key<input type="password" autoComplete="off" spellCheck={false} disabled={disabled} maxLength={1024} placeholder="Paste your API key" value={connection.key} onChange={e => change({ ...connection, key: e.target.value.trim() })} /></label>
    <label>Model ID<input value={connection.model} disabled={disabled} maxLength={100} spellCheck={false} onChange={e => change({ ...connection, model: e.target.value.trim() })} /></label>
    <div className="connection-check"><span className={status === 'checked' ? 'access-checked' : ''}>{status === 'checked' ? 'Access checked' : status === 'checking' ? 'Checking access…' : connection.key ? 'Key added · check access' : 'No key added'}</span>{status === 'checking' ? <button className="subtle-button" onClick={() => { cancel(); setStatus('cancelled'); }}>Cancel</button> : <button className="subtle-button" disabled={disabled || !connection.key || !connection.model} onClick={() => void check()}>Check access</button>}</div>
    <p className="connection-feedback" role="status" aria-live="polite">{status === 'idle' ? 'Keys stay in this tab and are cleared when you reload.' : status === 'checking' ? 'Looking up model details. No answer is generated.' : connectionMessages[status]}</p>
  </div>;
}
