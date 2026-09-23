import { decryptCredential, encryptCredential } from './credential-crypto.ts';
import { savedKeyReference, saveConnectionSchema, deleteConnectionSchema, type SavedConnection } from './saved-connections.ts';
import { providers, type ProviderId } from './trio.ts';

type Row = { cipher: string | null; iv: string | null; revision: number; model: string; enabled: number; updated_at: string };
export class CredentialError extends Error {
  status: number;
  constructor(message = 'Saved keys are unavailable. Open Connections and retry or replace the key.', status = 503) { super(message); this.status = status; }
}
export const readCredentialRow = (db: D1Database, userId: string, provider: ProviderId) => db.prepare('SELECT cipher, iv, revision, model, enabled, updated_at FROM provider_credentials WHERE user_id = ? AND provider = ?').bind(userId, provider).first<Row>();
function metadata(provider: ProviderId, row: Row | null): SavedConnection {
  return { provider, revision: row?.revision ?? 0, saved: Boolean(row?.cipher && row.iv), model: row?.model ?? providers.find(p => p.id === provider)!.model, enabled: row ? Boolean(row.enabled) : true, updatedAt: row?.updated_at ?? null };
}
export async function readSavedConnections(db: D1Database, userId: string) {
  return { connections: await Promise.all(providers.map(async p => metadata(p.id, await readCredentialRow(db, userId, p.id)))) };
}
async function writeRow(db: D1Database, userId: string, provider: ProviderId, revision: number, row: Omit<Row, 'revision'>) {
  const args = [row.cipher, row.iv, row.model, row.enabled, row.updated_at];
  const result = await db.batch([
    db.prepare('UPDATE provider_credentials SET cipher = ?, iv = ?, model = ?, enabled = ?, updated_at = ?, revision = revision + 1 WHERE user_id = ? AND provider = ? AND revision = ?').bind(...args, userId, provider, revision),
    db.prepare('INSERT INTO provider_credentials (user_id, provider, cipher, iv, model, enabled, updated_at, revision) SELECT ?, ?, ?, ?, ?, ?, ?, 1 WHERE ? = 0 ON CONFLICT (user_id, provider) DO NOTHING').bind(userId, provider, ...args, revision),
  ]);
  if (result.reduce((sum, r) => sum + r.meta.changes, 0) !== 1) throw new CredentialError('Saved keys changed in another tab. Reload saved connections before trying again.', 409);
  return metadata(provider, { ...row, revision: revision + 1 });
}
export async function saveCredential(db: D1Database, master: string | undefined, userId: string, value: unknown) {
  const input = saveConnectionSchema.parse(value);
  let encrypted;
  if (input.key) encrypted = await encryptCredential(master, userId, input.provider, input.key);
  else {
    const old = await readCredentialRow(db, userId, input.provider);
    if (!old?.cipher || !old.iv || old.revision !== input.revision) throw new CredentialError('Saved key changed or was removed. Reload saved connections before trying again.', 409);
    // Verify the key is still usable before confirming saved preferences.
    await decryptCredential(master, userId, input.provider, { cipher: old.cipher, iv: old.iv });
    encrypted = { cipher: old.cipher, iv: old.iv };
  }
  return writeRow(db, userId, input.provider, input.revision, { ...encrypted, model: input.model, enabled: Number(input.enabled), updated_at: new Date().toISOString() });
}
export async function deleteCredential(db: D1Database, userId: string, value: unknown) {
  const input = deleteConnectionSchema.parse(value);
  // Keep the revision after deletion so a stale tab cannot resurrect the key.
  return writeRow(db, userId, input.provider, input.revision, { cipher: null, iv: null, model: providers.find(p => p.id === input.provider)!.model, enabled: 0, updated_at: new Date().toISOString() });
}
export async function resolveCredential(db: D1Database | undefined, master: string | undefined, request: Request, userId: string, provider: ProviderId, value: string) {
  if (value !== savedKeyReference) return value;
  if (request.headers.get('x-trio-account') !== userId) throw new CredentialError('Your account changed. Sign in again before using saved keys.', 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new CredentialError('Reload Trio and try again.', 403);
  try {
    if (!db) throw new Error();
    const row = await readCredentialRow(db, userId, provider);
    if (!row?.cipher || !row.iv) throw new CredentialError('This saved key was removed. Open Connections and add or reload your key.', 409);
    return await decryptCredential(master, userId, provider, { cipher: row.cipher, iv: row.iv });
  } catch (error) { throw error instanceof CredentialError ? error : new CredentialError(); }
}
