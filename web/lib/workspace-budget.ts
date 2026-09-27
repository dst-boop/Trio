import { CredentialError } from './credential-store.ts';

// Workspace-provided keys are paid by the operator, so each account gets a daily
// allowance of provider calls made with them. Users' own keys are never counted.
// Every provider request is charged just before it is sent, retries and research
// continuations included, so the cap bounds what is actually dispatched.
export const defaultDailyWorkspaceCalls = 200;
export type WorkspaceBudgetEnv = { DB?: D1Database; TRIO_WORKSPACE_DAILY_CALLS?: string };

export function dailyWorkspaceCalls(env: WorkspaceBudgetEnv) {
  const raw = env.TRIO_WORKSPACE_DAILY_CALLS?.trim();
  if (!raw) return defaultDailyWorkspaceCalls;
  return /^\d{1,7}$/.test(raw) ? Number(raw) : defaultDailyWorkspaceCalls;
}

const usedUp = (limit: number) => new CredentialError(`Today's included usage is used up (${limit} provider calls per day, reset at 00:00 UTC). Add your own API key in Connections to keep going.`, 429);
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** Reserve `calls` from today's allowance, or throw a 429 CredentialError when it would be exceeded. */
export async function chargeWorkspaceCalls(env: WorkspaceBudgetEnv, userId: string, calls: number, now = Date.now()) {
  if (calls <= 0) return;
  const limit = dailyWorkspaceCalls(env);
  if (limit === 0) return; // explicitly disabled by the operator
  if (!env.DB) throw new CredentialError('Included connections are unavailable because usage could not be checked. Add your own API key in Connections.', 503);
  // One statement, so simultaneous requests cannot both pass a check-then-write.
  const row = await env.DB.prepare(
    'INSERT INTO workspace_usage (user_id, day, calls) SELECT ?1, ?2, ?3 WHERE ?3 <= ?4 '
    + 'ON CONFLICT (user_id, day) DO UPDATE SET calls = calls + excluded.calls WHERE workspace_usage.calls + excluded.calls <= ?4 '
    + 'RETURNING calls',
  ).bind(userId, utcDay(now), calls, limit).first<{ calls: number }>();
  if (!row) throw usedUp(limit);
}

/** Refuse up front when today's allowance is already used up, before a run starts. */
export async function assertWorkspaceCallsLeft(env: WorkspaceBudgetEnv, userId: string, now = Date.now()) {
  const limit = dailyWorkspaceCalls(env);
  if (limit === 0) return;
  if (!env.DB) throw new CredentialError('Included connections are unavailable because usage could not be checked. Add your own API key in Connections.', 503);
  const row = await env.DB.prepare('SELECT calls FROM workspace_usage WHERE user_id = ? AND day = ?').bind(userId, utcDay(now)).first<{ calls: number }>();
  if ((row?.calls ?? 0) >= limit) throw usedUp(limit);
}
