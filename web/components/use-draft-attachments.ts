'use client';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { readImageFile, type AttachedImage } from '@/lib/images';
import { readPdfFile, attachmentBytes, maxAttachmentBytes, type AttachedPdf } from '@/lib/pdf';

export type DraftAttachments = ReturnType<typeof useDraftAttachments>;

/**
 * The text, image and PDF attached to the unsent question.
 *
 * Each kind carries a version counter: a file that finishes reading after it
 * was removed, replaced or the workspace unmounted is dropped instead of
 * reappearing in a newer draft. `onClear` runs whenever an attachment is
 * removed, so the owner can forget anything derived from the old draft.
 */
export function useDraftAttachments(busy: boolean, onClear: () => void) {
  const [context, setContext] = useState<{ name: string; text: string } | null>(null), [contextLoading, setContextLoading] = useState(false), contextVersion = useRef(0);
  const [image, setImage] = useState<AttachedImage | null>(null), [imageLoading, setImageLoading] = useState(false), imageVersion = useRef(0);
  const [pdf, setPdf] = useState<AttachedPdf | null>(null), [pdfLoading, setPdfLoading] = useState(false), pdfVersion = useRef(0);
  useEffect(() => () => { contextVersion.current++; imageVersion.current++; pdfVersion.current++; }, []);

  function clearContext() { onClear(); contextVersion.current++; setContext(null); setContextLoading(false); }
  function clearImage() { onClear(); imageVersion.current++; setImage(null); setImageLoading(false); }
  function clearPdf() { onClear(); pdfVersion.current++; setPdf(null); setPdfLoading(false); }
  function clearAll() { clearContext(); clearImage(); clearPdf(); }

  async function attachContext(file?: File) {
    if (!file || busy) return;
    const version = ++contextVersion.current; setContextLoading(false);
    if (!/\.(txt|md|csv|json|js|ts|tsx|py|html|css)$/i.test(file.name)) return toast.error('Choose a text, Markdown, CSV, JSON, or code file.');
    if (file.size > 60000) return toast.error('Use a text file smaller than 60 KB.');
    setContextLoading(true);
    try { const text = await file.text(); if (version === contextVersion.current) setContext({ name: file.name, text }); }
    catch { if (version === contextVersion.current) toast.error('Could not read this text file. Choose the file again.'); }
    finally { if (version === contextVersion.current) setContextLoading(false); }
  }
  async function attachImage(file?: File) {
    if (!file || busy) return;
    const version = ++imageVersion.current; setImageLoading(true);
    try { const read = await readImageFile(file); if (version === imageVersion.current) setImage(read); }
    catch (error) { if (version === imageVersion.current) toast.error(error instanceof Error ? error.message : 'Could not load this image.'); }
    finally { if (version === imageVersion.current) setImageLoading(false); }
  }
  async function attachPdf(file?: File) {
    if (!file || busy) return;
    const version = ++pdfVersion.current; setPdfLoading(true);
    try { const read = await readPdfFile(file); if (version === pdfVersion.current) setPdf(read); }
    catch (error) { if (version === pdfVersion.current) toast.error(error instanceof Error ? error.message : 'Could not read this PDF.'); }
    finally { if (version === pdfVersion.current) setPdfLoading(false); }
  }
  /** Attach an image created in Trio, superseding any image still being read. */
  function attachGeneratedImage(generated: AttachedImage) {
    if (attachmentBytes(generated, pdf) > maxAttachmentBytes) throw new Error('This image and your PDF together exceed 4 MB. Download the image, then remove or replace the PDF before attaching it.');
    imageVersion.current++; setImage(generated); setImageLoading(false);
  }

  const loading = contextLoading || imageLoading || pdfLoading;
  return {
    context, contextLoading, image, imageLoading, pdf, pdfLoading, loading,
    present: Boolean(context || image || pdf || loading),
    tooLarge: attachmentBytes(image, pdf) > maxAttachmentBytes,
    attachContext, attachImage, attachPdf, attachGeneratedImage, clearContext, clearImage, clearPdf, clearAll,
  };
}
