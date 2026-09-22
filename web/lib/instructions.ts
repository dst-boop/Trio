import { z } from 'zod';

export const maxSessionInstructions = 6000;
export const instructionsSchema = z.string().max(maxSessionInstructions);
