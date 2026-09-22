import { z } from 'zod';

export const maxImageBytes = 4_000_000;
export type ImageInput = { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string };
export type AttachedImage = ImageInput & { name: string };

function detectImage(bytes: string): ImageInput['mimeType'] | null {
  if (bytes.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}
/** No remote URLs or SVG: uploaded bytes must match the declared raster type. */
function validImage(image: ImageInput): boolean {
  if (!image.data.length || image.data.length > Math.ceil(maxImageBytes / 3) * 4 || /[^A-Za-z0-9+/=]/.test(image.data)) return false;
  try {
    const bytes = atob(image.data);
    return bytes.length > 12 && bytes.length <= maxImageBytes && btoa(bytes) === image.data && detectImage(bytes) === image.mimeType;
  } catch { return false; }
}
export const imageSchema = z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), data: z.string().max(Math.ceil(maxImageBytes / 3) * 4) }).refine(validImage, 'Use a valid PNG, JPEG, or WebP image under 4 MB.');

export async function readImageFile(file: File): Promise<AttachedImage> {
  if (!file.size || file.size > maxImageBytes) throw new Error('Choose an image under 4 MB.');
  const buffer = new Uint8Array(await file.arrayBuffer());
  let bytes = '';
  for (let offset = 0; offset < buffer.length; offset += 32768) bytes += String.fromCharCode(...buffer.subarray(offset, offset + 32768));
  const mimeType = detectImage(bytes);
  if (!mimeType || file.type && file.type !== mimeType) throw new Error('Choose a PNG, JPEG, or WebP image with a matching file type.');
  const image = { mimeType, data: btoa(bytes) };
  if (!imageSchema.safeParse(image).success) throw new Error('This image could not be read. Choose another file.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('This image could not be decoded. Choose another file.'); }
  const tooLarge = bitmap.width > 8000 || bitmap.height > 8000; bitmap.close();
  if (tooLarge) throw new Error('Choose an image no larger than 8,000 pixels on either side.');
  return { ...image, name: file.name.replace(/[\r\n]/g, ' ').slice(0, 255) || 'Attached image' };
}
