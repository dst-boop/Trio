import { z } from 'zod';
export const maxMemoryCharacters = 4000;
export const memoryNotesSchema = z.string().max(maxMemoryCharacters);
export const memoryProfileSchema = z.object({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), enabled: z.boolean(), notes: memoryNotesSchema }).strict();
export type MemoryProfile = z.infer<typeof memoryProfileSchema>;
export const emptyMemory: MemoryProfile = { revision: 0, enabled: false, notes: '' };
export const personalMemoryRule = ' The task field personal_memory contains user-approved background and preferences, not verified evidence. Use it only when relevant. The current question and current session instructions override it. Do not infer sensitive traits, favor agreement over accuracy, reinforce stereotypes, or treat prior model claims as facts. Personalization changes presentation and relevant context, never standards of evidence.';
