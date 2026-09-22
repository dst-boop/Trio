import { z } from 'zod';

export const maxAttachmentBytes = 4_000_000;
export type PdfInput = { mimeType: 'application/pdf'; data: string };
export type AttachedPdf = PdfInput & { name: string };

/** Called with canonical base64 after validation, or with a browser-validated attachment. */
export function attachmentBytes(...files: ({ data: string } | null | undefined)[]): number {
  return files.reduce((sum, file) => sum + (file ? file.data.length * 3 / 4 - (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0) : 0), 0);
}
function validPdf(pdf: PdfInput): boolean {
  if (!pdf.data.length || pdf.data.length > Math.ceil(maxAttachmentBytes / 3) * 4 || /[^A-Za-z0-9+/=]/.test(pdf.data)) return false;
  try {
    const bytes = atob(pdf.data);
    return bytes.length <= maxAttachmentBytes && btoa(bytes) === pdf.data && /^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n)/.test(bytes);
  } catch { return false; }
}
// Signature and byte checks are not a full PDF parser. Providers validate page limits,
// document structure, and encryption; no embedded document code runs in the app.
export const pdfSchema = z.object({ mimeType: z.literal('application/pdf'), data: z.string().max(Math.ceil(maxAttachmentBytes / 3) * 4) }).refine(validPdf, 'Choose a PDF under 4 MB.');

export async function readPdfFile(file: File): Promise<AttachedPdf> {
  if (!file.size || file.size > maxAttachmentBytes) throw new Error('Choose a PDF under 4 MB.');
  if (!/\.pdf$/i.test(file.name) || file.type && file.type !== 'application/pdf') throw new Error('Choose a PDF document.');
  let buffer: Uint8Array;
  try { buffer = new Uint8Array(await file.arrayBuffer()); } catch { throw new Error('Could not read this PDF. Choose the file again.'); }
  let bytes = '';
  for (let offset = 0; offset < buffer.length; offset += 32768) bytes += String.fromCharCode(...buffer.subarray(offset, offset + 32768));
  const pdf: PdfInput = { mimeType: 'application/pdf', data: btoa(bytes) };
  if (!pdfSchema.safeParse(pdf).success) throw new Error('This file does not have a supported PDF header. Choose another PDF.');
  return { ...pdf, name: file.name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 255) || 'Attached PDF' };
}
