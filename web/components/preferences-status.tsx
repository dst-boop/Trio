'use client';
import type { PreferencesState } from '@/lib/preferences-client';

export function PreferencesStatus({ preferences, busy = false, temporaryDemo = false }: { preferences: PreferencesState & { reload: () => Promise<void>; retry: () => void }; busy?: boolean; temporaryDemo?: boolean }) {
  if (preferences.status === 'local') return null;
  return <div className={`preferences-status ${preferences.error ? 'has-error' : ''}`} role={preferences.error ? 'alert' : 'status'}>
    <span>{preferences.error || (preferences.status === 'loading' ? 'Loading your choices…' : preferences.status === 'saving' ? 'Saving your choices…' : preferences.persisted ? 'Mode and model choices saved to your account.' : 'Your mode and model choices will be saved to your account.')}</span>
    {temporaryDemo && <small>Demo is on for this tab after clearing its keys. Your saved Demo/Live choice is unchanged. Choose Live to return to it.</small>}
    {preferences.recovery === 'retry' && <button className="subtle-button" disabled={busy} onClick={preferences.retry}>Retry saving preferences</button>}
    {preferences.recovery === 'load' && <button className="subtle-button" disabled={busy} onClick={() => void preferences.reload()}>Load saved preferences</button>}
    {preferences.recovery === 'load' && <small>Loading replaces this tab&apos;s mode and model choices with the saved ones. Your draft stays here.</small>}
  </div>;
}
