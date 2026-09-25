import { z } from 'zod';

export const preferenceValuesSchema = z.object({
  demo: z.boolean(),
  mode: z.enum(['single', 'council', 'deep', 'fast', 'compare']),
  lead: z.enum(['openai', 'claude', 'gemini']),
}).strict();
export const workspacePreferencesSchema = preferenceValuesSchema.extend({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
}).strict();
export const preferencesResponseSchema = workspacePreferencesSchema.extend({ accountId: z.string().min(1) }).strict();
export type PreferenceValues = z.infer<typeof preferenceValuesSchema>;
export type WorkspacePreferences = z.infer<typeof workspacePreferencesSchema>;
export const defaultPreferences: WorkspacePreferences = { revision: 0, demo: true, mode: 'single', lead: 'openai' };
export const samePreferences = (a: PreferenceValues, b: PreferenceValues) => a.demo === b.demo && a.mode === b.mode && a.lead === b.lead;
