'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { PreferencesClient } from '@/lib/preferences-client';
import type { Mode, ProviderId } from '@/lib/trio';

export function useWorkspacePreferences(accountId?: string) {
  const [entry, setEntry] = useState(() => ({ accountId, client: new PreferencesClient(accountId) }));
  let client = entry.client;
  if (entry.accountId !== accountId) {
    client = new PreferencesClient(accountId);
    setEntry({ accountId, client });
  }
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => { void client.load(); return client.dispose; }, [client]);
  return {
    ...state, loading: state.status === 'loading', reload: client.load, retry: client.retry,
    setDemo: (demo: boolean) => client.update({ demo }),
    setMode: (mode: Mode) => client.update({ mode }),
    setLead: (lead: ProviderId) => client.update({ lead }),
  };
}
