import { generatedImageSchema, imageGenerationModel, imageGenerationSchema, maxImageGenerationResponseBytes } from './image-generation.ts';
import { readProviderJson } from './provider-response.ts';
import type { ImageInput } from './images.ts';
class GenerationError extends Error {}

/** One explicit generation, with no URL downloads, implicit retries, history or other providers. */
export async function generateImage(input: unknown, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<ImageInput> {
  const parsed = imageGenerationSchema.safeParse(input);
  if (!parsed.success) throw new Error('Enter a description under 4,000 characters, valid image settings, and your OpenAI API key.');
  const { key, ...options } = parsed.data;
  const timeout = AbortSignal.timeout(180_000), combined = AbortSignal.any([signal, timeout]);
  try {
    combined.throwIfAborted();
    const response = await fetcher('https://api.openai.com/v1/images/generations', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...options, model: imageGenerationModel, n: 1, output_format: 'jpeg', output_compression: 90, background: 'opaque', moderation: 'auto' }),
      signal: combined, redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw new GenerationError('OpenAI rejected access. Check your API key, image-model permissions, and account verification.');
      if (response.status === 429) throw new GenerationError('OpenAI is limiting requests. Check your API billing and limits.');
      throw new GenerationError('OpenAI could not generate this image. Check your description and account access before trying again.');
    }
    let data;
    try { data = await readProviderJson(response, combined, maxImageGenerationResponseBytes); }
    catch { combined.throwIfAborted(); throw new GenerationError('OpenAI returned an unreadable or oversized image. Try a smaller image or lower quality.'); }
    const image = generatedImageSchema.safeParse({ mimeType: 'image/jpeg', data: Array.isArray(data.data) && data.data.length === 1 ? data.data[0]?.b64_json : undefined });
    if (!image.success) throw new GenerationError('OpenAI did not return a supported JPEG under 4 MB. Try a smaller image or lower quality.');
    return image.data;
  } catch (error) {
    if (signal.aborted) throw new Error('Image generation cancelled. OpenAI may still bill work already started.');
    if (timeout.aborted) throw new Error('Image generation timed out. OpenAI may still bill work already started.');
    if (error instanceof GenerationError) throw error;
    throw new Error('Could not reach OpenAI. Check your connection before trying again.');
  }
}
