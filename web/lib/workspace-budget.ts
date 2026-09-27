import { CredentialError } from './credential-store.ts';

// Workspace-provided keys are paid by the operator, so each account gets a daily
// allowance of provider calls made with them. Users' own keys are never counted.
// The count is a reservation made before any provider is called: a run that fails
// or is cancelled still uses its share, so the operator's worst case stays bounded.
export const defaultDailyWorkspaceCalls = 200;
export type WorkspaceBudgetEnv = { DB?: D1Database; TRIO_WORKSPACE_DAILY_CALLS?: string };

export function dailyWorkspaceCalls(env: WorkspaceBudgetEnv) {
  const raw = env.TRIO_WORKSPACE_DAILY_CALLS?.trim();
  if (!raw) return defaultDailyWorkspaceCalls;
  return /^\d{1,7}$/.test(raw) ? Number(raw) : defaultDailyWorkspaceCalls;
}

// Upper-bound provider calls per workspace-funded model for one ask, by mode:
// Single and Compare answer once; Quick adds a synthesis; Council adds a review;
// Deep Council adds a revision round. Web research is one more call when funded.
const callsPerModel = { single: 1, compare: 1, fast: 2, council: 3, deep: 4 } as const;
export const askWorkspaceCalls = (mode: keyof typeof callsPerModel, fundedModels: number, fundedResearch: boolean) =>
  fundedModels * callsPerModel[mode] + (fundedResearch ? 1 : 0);

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
  if (!row) throw new CredentialError(`Today's included usage is used up (${limit} provider calls per day, reset at 00:00 UTC). Add your own API key in Connections to keep going.`, 429);
}
