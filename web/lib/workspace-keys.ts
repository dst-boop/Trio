import { CredentialError, resolveCredential } from './credential-store.ts';
import { savedKeyReference, workspaceKeyReference } from './saved-connections.ts';
import { providers, type Connections, type ProviderId } from './trio.ts';

// Workspace-provided provider keys: the operator sets these runtime secrets once and
// signed-in users get working connections without adding their own API keys.
const secretNames = { openai: 'TRIO_WORKSPACE_OPENAI_KEY', claude: 'TRIO_WORKSPACE_CLAUDE_KEY', gemini: 'TRIO_WORKSPACE_GEMINI_KEY' } as const;
export type WorkspaceKeyEnv = { DB?: D1Database; TRIO_CREDENTIAL_KEY?: string } & Partial<Record<(typeof secretNames)[ProviderId], string>>;
function workspaceKey(env: WorkspaceKeyEnv, provider: ProviderId) {
  const raw = env[secretNames[provider]];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^[!-~]{8,1024}$/.test(value) && value !== savedKeyReference && value !== workspaceKeyReference ? value : '';
}
export const workspaceAvailability = (env: WorkspaceKeyEnv) => Object.fromEntries(providers.map(p => [p.id, Boolean(workspaceKey(env, p.id))])) as Record<ProviderId, boolean>;
// Fill only providers the user has left key-less; explicit and saved keys always win.
export const applyWorkspaceConnections = (connections: Connections, available: Partial<Record<ProviderId, boolean>> | undefined): Connections =>
  Object.fromEntries(Object.entries(connections).map(([id, connection]) => [id, !connection.key && available?.[id as ProviderId] ? { ...connection, key: workspaceKeyReference } : connection])) as Connections;
export async function resolveRequestKey(env: WorkspaceKeyEnv, request: Request, userId: string, provider: ProviderId, value: string, expectedRevision?: number) {
  if (value !== workspaceKeyReference) return resolveCredential(env.DB, env.TRIO_CREDENTIAL_KEY, request, userId, provider, value, expectedRevision);
  if (request.headers.get('x-trio-account') !== userId) throw new CredentialError('Your account changed. Sign in again before using workspace connections.', 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new CredentialError('Reload Trio and try again.', 403);
  // Quality runs pin saved-key revisions; workspace connections have none to pin.
  if (expectedRevision !== undefined) throw new CredentialError('Quality checks use your own saved keys. Save a key in Connections first.', 409);
  const key = workspaceKey(env, provider);
  if (!key) throw new CredentialError(`The workspace connection for ${providers.find(p => p.id === provider)!.name} is not configured. Add your own API key in Connections.`, 503);
  return key;
}
