import { defaultPreferences, preferenceValuesSchema, preferencesResponseSchema, samePreferences, type PreferenceValues, type WorkspacePreferences } from './workspace-preferences.ts';

export type PreferencesState = {
  value: PreferenceValues;
  status: 'loading' | 'saved' | 'saving' | 'error' | 'local';
  error: string;
  recovery: 'load' | 'retry' | 'account' | null;
  persisted: boolean;
};
type Transport = (url: string, init: RequestInit) => Promise<Response>;

/** Only explicit choices write. Reads, reloads and hydration never do. */
export class PreferencesClient {
  private listeners = new Set<() => void>();
  private state: PreferencesState;
  private saved: WorkspacePreferences = { ...defaultPreferences };
  private desired: PreferenceValues = { demo: defaultPreferences.demo, mode: defaultPreferences.mode, lead: defaultPreferences.lead };
  private attempt?: WorkspacePreferences;
  private loaded = false;
  private blocked = false;
  private saving = false;
  private generation = 0;
  private controller = new AbortController();
  private accountId: string | undefined;
  private transport: Transport;
  constructor(accountId: string | undefined, transport: Transport = (url, init) => fetch(url, init)) {
    this.accountId = accountId; this.transport = transport;
    this.state = { value: this.desired, status: accountId ? 'loading' : 'local', error: '', recovery: null, persisted: false };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<PreferencesState>) {
    this.state = { ...this.state, ...patch, value: { ...this.desired }, persisted: this.saved.revision > 0 };
    this.listeners.forEach(listener => listener());
  }
  dispose = () => { this.generation++; this.controller.abort(); };
  private options(): RequestInit {
    return { headers: { 'Content-Type': 'application/json', 'X-Trio-Account': this.accountId! }, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]), cache: 'no-store' };
  }
  load = async () => {
    this.dispose(); const version = this.generation;
    this.controller = new AbortController(); this.loaded = false; this.blocked = false; this.saving = false; this.attempt = undefined;
    if (!this.accountId) { this.emit({ status: 'local', error: '', recovery: null }); return; }
    this.emit({ status: 'loading', error: '', recovery: null });
    try {
      const response = await this.transport('/api/preferences', this.options());
      const data = await response.json();
      if (version !== this.generation) return;
      if (response.status === 401) {
        this.blocked = true; this.emit({ status: 'error', error: 'Your account changed. Reload Trio before saving preferences.', recovery: 'account' }); return;
      }
      if (!response.ok) throw new Error();
      const parsed = preferencesResponseSchema.parse(data);
      if (parsed.accountId !== this.accountId) {
        this.blocked = true; this.emit({ status: 'error', error: 'Your account changed. Reload Trio before saving preferences.', recovery: 'account' }); return;
      }
      const { accountId: _, ...saved } = parsed;
      this.saved = saved; this.desired = { demo: saved.demo, mode: saved.mode, lead: saved.lead }; this.loaded = true;
      this.emit({ status: 'saved', error: '', recovery: null });
    } catch {
      if (version !== this.generation) return;
      this.emit({ status: 'error', error: 'Saved preferences are unavailable. Your choices work only in this tab until you load them again.', recovery: 'load' });
    }
  };
  update = (patch: Partial<PreferenceValues>) => {
    if (this.state.status === 'loading' || this.controller.signal.aborted) return;
    this.desired = preferenceValuesSchema.parse({ ...this.desired, ...patch });
    this.emit({});
    if (!this.accountId || !this.loaded || this.blocked) return;
    void this.flush();
  };
  retry = () => {
    if (this.state.recovery !== 'retry' || this.controller.signal.aborted) return;
    this.blocked = false; void this.flush();
  };
  private async flush() {
    if (this.saving || this.blocked || !this.loaded || !this.accountId) return;
    if (!this.attempt && samePreferences(this.saved, this.desired)) { this.emit({ status: 'saved', error: '', recovery: null }); return; }
    this.saving = true; const version = this.generation;
    this.emit({ status: 'saving', error: '', recovery: null });
    try {
      while (this.attempt || !samePreferences(this.saved, this.desired)) {
        const attempt = this.attempt ??= { ...this.desired, revision: this.saved.revision };
        const response = await this.transport('/api/preferences', { ...this.options(), method: 'PUT', body: JSON.stringify(attempt) });
        const data = await response.json();
        if (version !== this.generation) return;
        if (!response.ok) {
          this.blocked = true;
          const recovery = response.status === 409 ? 'load' : response.status < 500 ? 'account' : 'retry';
          const error = recovery === 'load' ? 'Preferences changed in another tab or device. Load saved preferences to continue saving.' : response.status === 401 ? 'Your account changed. Reload Trio before saving preferences.' : recovery === 'account' ? 'This version of Trio could not save preferences. Reload Trio before trying again.' : 'Preferences were not confirmed saved. Your choices work in this tab; retry saving.';
          this.emit({ status: 'error', error, recovery }); return;
        }
        const parsed = preferencesResponseSchema.parse(data);
        if (parsed.accountId !== this.accountId) {
          this.blocked = true; this.emit({ status: 'error', error: 'Your account changed. Reload Trio before saving preferences.', recovery: 'account' }); return;
        }
        if (parsed.revision !== attempt.revision + 1 || !samePreferences(parsed, attempt)) throw new Error();
        const { accountId: _, ...saved } = parsed;
        this.saved = saved; this.attempt = undefined;
      }
      this.emit({ status: 'saved', error: '', recovery: null });
    } catch {
      if (version !== this.generation) return;
      this.blocked = true;
      this.emit({ status: 'error', error: 'Preferences were not confirmed saved. Your choices work in this tab; retry saving.', recovery: 'retry' });
    } finally { if (version === this.generation) this.saving = false; }
  }
}
