'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { serializeSessions, type Session } from '@/lib/sessions';
import { workspaceSchema } from '@/lib/account-store';
import { z } from 'zod';
const responseError = (data: unknown, fallback: string) => z.object({ error: z.string() }).safeParse(data).data?.error ?? fallback;

export function useAccountWorkspace(accountId: string | undefined, sessions: Session[], restore: (sessions: Session[]) => void) {
  const enabled = Boolean(accountId);
  const [ready, setReady] = useState(false), [status, setStatus] = useState('Loading your workspace…'), [error, setError] = useState('');
  const [conflict, setConflict] = useState(false), [tick, setTick] = useState(0);
  const state = useRef({ revision: 0, saved: '', pending: '', saving: false, blocked: false });
  const restoreRef = useRef(restore); restoreRef.current = restore;
  const alive = useRef(true);
  const flush = useCallback(async () => {
    const s = state.current;
    if (s.saving || s.blocked || s.pending === s.saved) return;
    s.saving = true; setStatus('Saving…');
    try {
      while (alive.current && s.pending !== s.saved && !s.blocked) {
        const snapshot = s.pending;
        const response = await fetch('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Trio-Account': accountId! }, body: JSON.stringify({ revision: s.revision, sessions: JSON.parse(snapshot) }) });
        const data = await response.json();
        if (!response.ok) { setConflict(response.status === 409); throw new Error(responseError(data, 'Could not save. Download a backup before closing this tab.')); }
        s.revision = z.object({ revision: z.number().int().positive() }).parse(data).revision; s.saved = snapshot;
      }
      if (alive.current) { setStatus('Saved to your account'); setError(''); }
    } catch (e) { s.blocked = true; if (alive.current) { setError(e instanceof Error ? e.message : 'Could not save your workspace.'); setStatus('Changes not saved'); } }
    finally { s.saving = false; }
  }, [accountId]);
  useEffect(() => {
    if (!enabled) return;
    alive.current = true; let cancelled = false;
    setReady(false); setError(''); setStatus('Loading your workspace…');
    fetch('/api/workspace', { cache: 'no-store', headers: { 'X-Trio-Account': accountId! } }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error(responseError(data, 'Could not load your workspace.'));
      const payload = z.object({ revision: z.number(), sessions: z.unknown(), accountId: z.string() }).parse(data);
      if (payload.accountId !== accountId) throw new Error('The signed-in account changed. Reload this page.');
      const snapshot = workspaceSchema.parse({ revision: payload.revision, sessions: payload.sessions }); if (cancelled) return;
      const serialized = serializeSessions(snapshot.sessions);
      state.current = { revision: snapshot.revision, saved: serialized, pending: serialized, saving: false, blocked: false };
      restoreRef.current(snapshot.sessions); setReady(true); setConflict(false); setStatus('Saved to your account');
    }).catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Could not load your workspace.'); setStatus('Workspace unavailable'); } });
    return () => { cancelled = true; alive.current = false; };
  }, [enabled, accountId, tick]);
  useEffect(() => {
    if (!enabled || !ready) return;
    try { state.current.pending = serializeSessions(sessions); }
    catch { state.current.blocked = true; setError('This workspace exceeds the save limit. Download a backup and remove older sessions.'); setStatus('Changes not saved'); return; }
    if (state.current.pending === state.current.saved || state.current.blocked) return;
    setStatus('Saving…'); const timer = setTimeout(() => { void flush(); }, 450);
    return () => clearTimeout(timer);
  }, [enabled, ready, sessions, flush]);
  useEffect(() => {
    if (!enabled) return;
    const warn = (e: BeforeUnloadEvent) => { const s = state.current; if (s.saving || s.pending !== s.saved || s.blocked) { e.preventDefault(); e.returnValue = ''; } };
    const hidden = () => { if (document.visibilityState === 'hidden') void flush(); };
    window.addEventListener('beforeunload', warn); document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('visibilitychange', hidden); };
  }, [enabled, flush]);
  return { ready, status, error, conflict, reload: () => setTick(t => t + 1), retry: () => {
    try { state.current.pending = serializeSessions(sessions); }
    catch { setError('This workspace exceeds the save limit. Download a backup and remove older sessions.'); return; }
    state.current.blocked = false; setError(''); void flush();
  } };
}
