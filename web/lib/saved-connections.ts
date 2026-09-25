import { z } from 'zod';

// Public references, never credentials. Only the authenticated server resolves them.
export const savedKeyReference = '__TRIO_SAVED_KEY__';
export const workspaceKeyReference = '__TRIO_WORKSPACE_KEY__';
export const providerIdSchema = z.enum(['openai', 'claude', 'gemini']);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
export const savedConnectionSchema = z.object({
  provider: providerIdSchema, revision, saved: z.boolean(),
  model: z.string(), enabled: z.boolean(), updatedAt: z.string().nullable(),
}).strict();
export type SavedConnection = z.infer<typeof savedConnectionSchema>;
export const workspaceAvailabilitySchema = z.object({ openai: z.boolean(), claude: z.boolean(), gemini: z.boolean() }).strict();
export const savedConnectionsSchema = z.object({ connections: z.array(savedConnectionSchema).length(3), workspace: workspaceAvailabilitySchema.optional() }).strict();
export const saveConnectionSchema = z.object({
  provider: providerIdSchema, revision,
  key: z.string().trim().min(1).max(1024).regex(/^[!-~]+$/).refine(key => key !== savedKeyReference && key !== workspaceKeyReference).optional(),
  model: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  enabled: z.boolean(),
}).strict();
export const deleteConnectionSchema = z.object({ provider: providerIdSchema, revision }).strict();
