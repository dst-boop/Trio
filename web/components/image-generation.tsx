'use client';
import './image-generation.css';
import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { generatedImageSchema, imageDescriptionLimit, imageGenerationModel, maxImageGenerationResponseBytes, type GenerationOptions } from '@/lib/image-generation';
import { readImageFile, type AttachedImage } from '@/lib/images';
import { readProviderJson } from '@/lib/provider-response';

type Preview = GenerationOptions & { image: AttachedImage; url: string };
export function ImageGeneration({ accountId, apiKey, live, disabled, question, replacingImage, onAttach, onConnections }: { accountId?: string; apiKey: string; live: boolean; disabled: boolean; question: string; replacingImage: boolean; onAttach: (image: AttachedImage) => void; onConnections: () => void }) {
  const [open, setOpen] = useState(false), [discard, setDiscard] = useState(false);
  const [prompt, setPrompt] = useState(''), [size, setSize] = useState<GenerationOptions['size']>('1024x1024'), [quality, setQuality] = useState<GenerationOptions['quality']>('medium');
  const [result, setResult] = useState<Preview | null>(null), [running, setRunning] = useState(false), [error, setError] = useState('');
  const version = useRef(0), controller = useRef<AbortController | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ready = Boolean(accountId && live && apiKey.trim()), dirty = Boolean(prompt || result || running);
  function stop(message = 'Image generation cancelled. OpenAI may still bill work already started.') {
    version.current++; controller.current?.abort(); controller.current = null;
    if (timer.current) clearTimeout(timer.current); timer.current = null; setRunning(false); if (message) setError(message);
  }
  function reset() { stop(''); setPrompt(''); setSize('1024x1024'); setQuality('medium'); setResult(null); setError(''); setDiscard(false); setOpen(false); }
  function close(value: boolean) { if (value) setOpen(true); else if (dirty) { stop(running ? undefined : ''); setDiscard(true); } else reset(); }
  useEffect(() => () => { version.current++; controller.current?.abort(); if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
  async function generate() {
    if (!ready || !prompt.trim() || running || controller.current) return;
    const options = { prompt: prompt.trim(), size, quality }, id = ++version.current, abort = new AbortController(); controller.current = abort;
    setRunning(true); setError(''); timer.current = setTimeout(() => { if (id === version.current) stop('Image generation timed out. OpenAI may still bill work already started.'); }, 210_000);
    try {
      const response = await fetch('/api/images/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trio-Account': accountId! }, body: JSON.stringify({ ...options, key: apiKey }), signal: abort.signal, redirect: 'error', cache: 'no-store' });
      if (id !== version.current) { void response.body?.cancel().catch(() => {}); return; }
      const data = await readProviderJson(response, abort.signal, maxImageGenerationResponseBytes);
      if (id !== version.current) return;
      if (!response.ok) { setError(typeof data.error === 'string' && data.error.length <= 500 ? data.error : 'Could not create the image. Try again.'); return; }
      const parsed = generatedImageSchema.safeParse(data.image);
      if (!parsed.success) { setError('No supported JPEG image was returned. Try again.'); return; }
      const file = new File([Uint8Array.from(atob(parsed.data.data), c => c.charCodeAt(0))], 'trio-generated-image.jpg', { type: 'image/jpeg' });
      const image = await readImageFile(file);
      if (id !== version.current) return;
      setResult({ ...options, image, url: URL.createObjectURL(file) });
    } catch { if (id === version.current) setError('Could not finish or decode the generated image. Your previous image is still here, if one was created.'); }
    finally { if (id === version.current) { setRunning(false); controller.current = null; if (timer.current) clearTimeout(timer.current); timer.current = null; } }
  }
  function download() { if (!result) return; const link = document.createElement('a'); link.href = result.url; link.download = 'trio-generated-' + new Date().toISOString().slice(0, 10) + '.jpg'; link.click(); }
  function attach() { if (!result || running) return; try { onAttach(result.image); reset(); toast.success('Generated image attached. Add your question, then Ask Trio.'); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not attach the image. Download it to keep a copy.'); } }
  return <>
    <button className="attach-button" disabled={disabled} onClick={() => setOpen(true)}><ImagePlus size={17} /><span>Create image</span></button>
    <Dialog open={open} onOpenChange={close}><DialogContent className="image-generation-dialog"><DialogTitle>Create an image</DialogTitle><DialogDescription>Describe a visual, generate it with OpenAI, then download it or ask your Trio team to review it.</DialogDescription>
      {!ready && <p className="image-generation-note">{!accountId ? 'Sign in to generate images.' : <>Enable OpenAI with your API key and switch to Live in <button onClick={() => { setOpen(false); onConnections(); if (prompt) toast('Description kept. Reopen Create image after connecting.'); }}>Connections</button>.</>}</p>}
      <label className="image-generation-prompt">Image description<textarea aria-label="Image description" value={prompt} maxLength={imageDescriptionLimit} disabled={running} onChange={event => setPrompt(event.target.value)} placeholder="A luminous observatory above a quiet ocean, cinematic lighting, blue and violet palette…" rows={4} /><small>{prompt.length.toLocaleString()} / 4,000 characters</small></label>
      <button className="image-secondary" disabled={running || !question.trim()} onClick={() => { if (question.length > imageDescriptionLimit) { setError('Your question is longer than 4,000 characters. Copy the relevant part into the image description.'); return; } setPrompt(question); setError(''); }}>Use current question as description</button>
      <div className="image-generation-settings"><label>Shape<select aria-label="Image shape" value={size} disabled={running} onChange={event => setSize(event.target.value as GenerationOptions['size'])}><option value="1024x1024">Square · 1024 × 1024</option><option value="1536x1024">Landscape · 1536 × 1024</option><option value="1024x1536">Portrait · 1024 × 1536</option></select></label><label>Quality<select aria-label="Image quality" value={quality} disabled={running} onChange={event => setQuality(event.target.value as GenerationOptions['quality'])}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label></div>
      <p className="image-generation-note">Each generation is one paid OpenAI request using {imageGenerationModel}. Larger images and higher quality can cost more. Charges are separate from Trio’s answer usage totals. Only this description and image settings are sent; conversation history, personal memory, and attachments are excluded.</p>
      <div className="image-generation-actions">{running ? <button className="image-secondary" onClick={() => stop()}>Stop image generation</button> : <button className="image-primary" disabled={!ready || !prompt.trim()} onClick={() => void generate()}>{result ? 'Generate another image' : 'Generate with OpenAI'}</button>}</div>
      {running && <p role="status">Creating your image… This may take a few minutes. Stopping may not prevent charges for work already started.</p>}
      {error && <p className="image-generation-error" role="alert">{error}</p>}
      {result && <figure className="generated-image"><img src={result.url} alt="AI-generated result for your image description" /><figcaption><strong>AI-generated image</strong><span>Requested {result.size.replace('x', ' × ')} · {result.quality} quality · JPEG</span><details><summary>Description used</summary><p>{result.prompt}</p></details></figcaption><div className="image-generation-actions"><button className="image-secondary" onClick={download}><Download size={15} />Download JPEG</button><button className="image-secondary" disabled={running} onClick={attach}>{replacingImage ? 'Replace attached image' : 'Attach to question'}</button></div></figure>}
      <p className="image-generation-note">Download a copy to keep it. Generated images and descriptions are not saved to Trio history. Attaching keeps your question text and sends the image to enabled models only when you choose Ask Trio. Generated visuals may contain invented details or incorrect text.</p>
    </DialogContent></Dialog>
    <AlertDialog open={discard} onOpenChange={setDiscard}><AlertDialogContent><AlertDialogTitle>Discard this image draft?</AlertDialogTitle><AlertDialogDescription>The description and generated image will be cleared from this tool. Download your image first if you want to keep it. Any running generation has been stopped; OpenAI may still bill work already started.</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>Keep working</AlertDialogCancel><AlertDialogAction onClick={reset}>Discard image draft</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>;
}
