import { z } from 'zod';
import { imageSchema } from './images.ts';

export const imageGenerationModel = 'gpt-image-2.5-flare';
export const maxImageGenerationResponseBytes = 6_000_000;
export const imageDescriptionLimit = 4_000;
export const generationOptions = z.object({
  prompt: z.string().trim().min(1).max(imageDescriptionLimit),
  size: z.enum(['1024x1024', '1536x1024', '1024x1536']),
  quality: z.enum(['low', 'medium', 'high']),
}).strict();
export type GenerationOptions = z.infer<typeof generationOptions>;
export const imageGenerationSchema = generationOptions.extend({ key: z.string().trim().min(1).max(1024).regex(/^[!-~]+$/) }).strict();
export const generatedImageSchema = imageSchema.refine(image => image.mimeType === 'image/jpeg', 'Expected a JPEG image under 4 MB.');
