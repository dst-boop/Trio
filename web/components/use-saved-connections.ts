'use client';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { savedConnectionsSchema, savedConnectionSchema, savedKeyReference, type SavedConnection } from '@/lib/saved-connections';
import { freshConnections, type Connections, type ProviderId } from '@/lib/trio';
import { z } from 'zod';

export function useSavedConnections(accountId: string | undefined, setConnections: Dispatch<SetStateAction<Connections>>) {
  const [metadata, setMetadata] = useState<Partial<Record<ProviderId, SavedConnection>>>({});
  const [loading, setLoading] = useState(Boolean(accountId)), [error, setError] = useState('');
  const [saving, setSaving] = useState<ProviderId | null>(null);
  const active = useRef<AbortController | null>(null);
  const account = useRef(accountId); account.current = accountId;
  const loadedAccount = useRef(accountId);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration(value => value + 1), []);
  useEffect(() => {
    if (loadedAccount.current !== accountId) {
      setConnections(freshConnections()); setMetadata({}); setSaving(null); setError(''); loadedAccount.current = accountId;
    }
    if (!accountId) { setMetadata({}); setLoading(false); return; }
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    setLoading(true); setError('');
    void (async () => {
      try {
        const response = await fetch('/api/connections', { headers: { 'X-Trio-Account': accountId }, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error();
        const data = savedConnectionsSchema.parse(await response.json());
        if (controller.signal.aborted || account.current !== accountId) return;
        setMetadata(Object.fromEntries(data.connections.map(item => [item.provider, item])));
        setConnections(previous => {
          const next = { ...previous };
          for (const item of data.connections) {
            // Explicitly typed, unsaved replacements survive refresh/conflict recovery.
            if (previous[item.provider].key && previous[item.provider].key !== savedKeyReference) continue;
            next[item.provider] = item.saved ? { key: savedKeyReference, model: item.model, enabled: item.enabled } : freshConnections()[item.provider];
          }
          return next;
        });
      } catch { if (!controller.signal.aborted) setError('Saved connections could not be loaded. Retry to use or change your saved keys.'); }
      finally { if (!controller.signal.aborted) { setLoading(false); active.current = null; } }
    })();
    return () => { controller.abort(); active.current?.abort(); active.current = null; };
  }, [accountId, generation, setConnections]);

  async function change(provider: ProviderId, connection: Connections[ProviderId], remove: boolean) {
    const old = metadata[provider];
    if (!accountId || !old || loading || saving || error) return;
    const controller = new AbortController(); active.current = controller; setSaving(provider); setError('');
    try {
      const response = await fetch('/api/connections', {
        method: remove ? 'DELETE' : 'PUT', headers: { 'Content-Type': 'application/json', 'X-Trio-Account': accountId },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        body: JSON.stringify({ provider, revision: old.revision, ...(remove ? {} : { model: connection.model, enabled: connection.enabled, ...(connection.key === savedKeyReference ? {} : { key: connection.key }) }) }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? 'Saved keys changed in another tab. Reload saved connections, then review your changes.' : 'Your change was not confirmed. Reload saved connections before trying again.');
      const item = z.object({ connection: savedConnectionSchema }).parse(await response.json()).connection;
      if (item.provider !== provider) throw new Error('Your change was not confirmed. Reload saved connections.');
      if (controller.signal.aborted || account.current !== accountId) return;
      setMetadata(previous => ({ ...previous, [provider]: item }));
      setConnections(previous => ({ ...previous, [provider]: remove ? freshConnections()[provider] : { key: savedKeyReference, model: item.model, enabled: item.enabled } }));
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error && !['AbortError', 'TimeoutError'].includes(cause.name) ? cause.message : 'Your change was not confirmed. Reload saved connections before trying again.'); }
    finally { if (!controller.signal.aborted) { setSaving(null); active.current = null; } }
  }
  return { metadata, loading, error, saving, reload, save: (id: ProviderId, connection: Connections[ProviderId]) => change(id, connection, false), remove: (id: ProviderId, connection: Connections[ProviderId]) => change(id, connection, true) };
}
