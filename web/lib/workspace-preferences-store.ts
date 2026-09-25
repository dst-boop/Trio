import { defaultPreferences, workspacePreferencesSchema, type WorkspacePreferences } from './workspace-preferences.ts';
import type { ProviderId } from './trio.ts';

type Row = { revision: number; demo: number; mode: string; lead: string };
export async function readWorkspacePreferences(db: D1Database, userId: string, included: Partial<Record<ProviderId, boolean>> = {}): Promise<WorkspacePreferences> {
  const row = await db.prepare('SELECT revision, demo, mode, lead FROM workspace_preferences WHERE user_id = ?').bind(userId).first<Row>();
  if (row) return workspacePreferencesSchema.parse({ ...row, demo: Boolean(row.demo) });
  // Only availability is needed to choose a first-use model. No key is decrypted.
  const saved = await db.prepare('SELECT provider, enabled, cipher IS NOT NULL AND iv IS NOT NULL AS saved FROM provider_credentials WHERE user_id = ?').bind(userId).all<{ provider: string; enabled: number; saved: number }>();
  const lead = (['openai', 'claude', 'gemini'] as const).find(id => {
    const connection = saved.results.find(row => row.provider === id);
    return connection ? Boolean(connection.enabled && (connection.saved || included[id])) : Boolean(included[id]);
  }) ?? defaultPreferences.lead;
  return { ...defaultPreferences, lead };
}

export async function writeWorkspacePreferences(db: D1Database, userId: string, input: WorkspacePreferences): Promise<boolean> {
  const value = workspacePreferencesSchema.parse(input);
  const result = await db.batch<Row>([
    db.prepare('UPDATE workspace_preferences SET revision = revision + 1, demo = ?, mode = ?, lead = ? WHERE user_id = ? AND revision = ?').bind(Number(value.demo), value.mode, value.lead, userId, value.revision),
    db.prepare('INSERT INTO workspace_preferences (user_id, revision, demo, mode, lead) SELECT ?, 1, ?, ?, ? WHERE ? = 0 ON CONFLICT(user_id) DO NOTHING').bind(userId, Number(value.demo), value.mode, value.lead, value.revision),
    db.prepare('SELECT revision, demo, mode, lead FROM workspace_preferences WHERE user_id = ?').bind(userId),
  ]);
  const saved = result[2].results[0];
  // An identical retry can acknowledge a committed write whose response was lost.
  return saved?.revision === value.revision + 1 && saved.demo === Number(value.demo) && saved.mode === value.mode && saved.lead === value.lead;
}
