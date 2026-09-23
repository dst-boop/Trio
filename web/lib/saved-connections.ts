import { z } from 'zod';

// A public reference, never a credential. Only the authenticated server resolves it.
export const savedKeyReference = '__TRIO_SAVED_KEY__';
export const providerIdSchema = z.enum(['openai', 'claude', 'gemini']);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
export const savedConnectionSchema = z.object({
  provider: providerIdSchema, revision, saved: z.boolean(),
  model: z.string(), enabled: z.boolean(), updatedAt: z.string().nullable(),
}).strict();
export type SavedConnection = z.infer<typeof savedConnectionSchema>;
export const savedConnectionsSchema = z.object({ connections: z.array(savedConnectionSchema).length(3) }).strict();
export const saveConnectionSchema = z.object({
  provider: providerIdSchema, revision,
  key: z.string().trim().min(1).max(1024).regex(/^[!-~]+$/).refine(key => key !== savedKeyReference).optional(),
  model: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  enabled: z.boolean(),
}).strict();
export const deleteConnectionSchema = z.object({ provider: providerIdSchema, revision }).strict();
