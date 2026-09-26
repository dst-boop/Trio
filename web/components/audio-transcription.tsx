'use client';
import './audio-transcription.css';
import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { appendTranscript, readAudioFile, transcriptionModel, type AttachedAudio } from '@/lib/audio';
import { readProviderJson } from '@/lib/provider-response';

export function AudioTranscription({ accountId, apiKey, live, open, onOpenChange: setOpen, question, onAppend, onConnections }: { accountId?: string; apiKey: string; live: boolean; open: boolean; onOpenChange: (open: boolean) => void; question: string; onAppend: (question: string) => void; onConnections: () => void }) {
  const [discard, setDiscard] = useState(false);
  const [audio, setAudio] = useState<AttachedAudio | null>(null), [preview, setPreview] = useState('');
  const [transcript, setTranscript] = useState(''), [completed, setCompleted] = useState(false);
  const [loading, setLoading] = useState(false), [running, setRunning] = useState(false), [error, setError] = useState('');
  const version = useRef(0), controller = useRef<AbortController | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ready = Boolean(accountId && live && apiKey.trim());
  const dirty = Boolean(audio || transcript || loading || running);
  function stop(message = 'Transcription cancelled. OpenAI may still bill work already started.') {
    version.current++; controller.current?.abort(); controller.current = null;
    if (timer.current) clearTimeout(timer.current); timer.current = null;
    setRunning(false); setLoading(false); if (message) setError(message);
  }
  function reset() {
    stop(''); setAudio(null); setTranscript(''); setCompleted(false); setError(''); setOpen(false); setDiscard(false);
  }
  useEffect(() => () => { version.current++; controller.current?.abort(); if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!open || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [open, dirty]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => { if (!open) setPreview(''); }, [open]);
  function close(next: boolean) {
    if (next) { setOpen(true); return; }
    if (dirty) { stop(running ? undefined : ''); setDiscard(true); } else reset();
  }
  async function choose(file?: File) {
    if (!file) return;
    const id = ++version.current; setLoading(true); setError('');
    try { const selected = await readAudioFile(file); if (id === version.current) { setAudio(selected); setPreview(URL.createObjectURL(file)); } }
    catch (cause) { if (id === version.current) setError(cause instanceof Error ? cause.message : 'Could not read the recording.'); }
    finally { if (id === version.current) setLoading(false); }
  }
  async function transcribe() {
    if (!ready || !audio || running || completed) return;
    const id = ++version.current, abort = new AbortController(); controller.current = abort;
    setRunning(true); setError('');
    timer.current = setTimeout(() => { if (id === version.current) stop('Transcription timed out. OpenAI may still bill work already started.'); }, 150_000);
    try {
      const response = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trio-Account': accountId! }, body: JSON.stringify({ key: apiKey, audio: { format: audio.format, data: audio.data } }), signal: abort.signal, redirect: 'error', cache: 'no-store' });
      if (id !== version.current) { void response.body?.cancel().catch(() => {}); return; }
      const data = await readProviderJson(response, abort.signal);
      if (id !== version.current) return;
      if (!response.ok) { setError(typeof data.error === 'string' && data.error.length <= 500 ? data.error : 'Could not transcribe the recording. Try again.'); return; }
      if (typeof data.transcript !== 'string' || !data.transcript.trim() || data.transcript.length > 60_000) { setError('No usable transcript was returned. Try a shorter recording.'); return; }
      setTranscript(data.transcript); setCompleted(true);
    } catch { if (id === version.current) setError('Could not finish transcription. Check your connection before trying again.'); }
    finally { if (id === version.current) { setRunning(false); controller.current = null; if (timer.current) clearTimeout(timer.current); timer.current = null; } }
  }
  function append() {
    try { const combined = appendTranscript(question, transcript); onAppend(combined); reset(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add the transcript.'); }
  }
  return <>
    <Dialog open={open} onOpenChange={close}><DialogContent className="audio-dialog"><DialogTitle>Turn a recording into a question</DialogTitle><DialogDescription>Transcribe a short voice note, review what was heard, then add the text to your question.</DialogDescription>
      <p className="audio-note">MP3, WAV, M4A, or WebM under 4 MB. Use short clips; long recordings may produce incomplete transcripts. Check names, numbers, and missing words against the recording.</p>
      {!ready && <p className="audio-note">{!accountId ? 'Sign in to use audio transcription.' : <>Switch to Live and enable OpenAI with your API key in <button className="text-link" onClick={() => { reset(); onConnections(); }}>Connections</button>.</>}</p>}
      {!audio && <label className="audio-file">Choose recording<input type="file" aria-label="Choose recording" accept=".mp3,.wav,.m4a,.webm" disabled={!ready || loading} onChange={event => { void choose(event.target.files?.[0]); event.target.value = ''; }} /></label>}
      {loading && <p role="status">Reading recording…</p>}
      {audio && <div className="audio-preview"><strong>{audio.name}</strong>{preview && <audio controls preload="metadata" src={preview}>Play your original file to check the transcript.</audio>}</div>}
      <p className="audio-note">“Transcribe with OpenAI” sends this recording only to OpenAI using {transcriptionModel}. Each attempt is billed separately by OpenAI, outside Trio’s answer usage totals. Trio does not save the recording.</p>
      {completed && <label className="audio-transcript">Review and edit transcript<textarea aria-label="Review and edit transcript" value={transcript} maxLength={60_000} onChange={event => { setTranscript(event.target.value); setError(''); }} rows={8} /><small>{transcript.length.toLocaleString()} characters. Adding text preserves your existing question. The combined question must fit 20,000 characters.</small></label>}
      {completed && <p className="audio-note">The text goes to your enabled models only when you choose Ask Trio, and is saved with the completed conversation. Transcription can make mistakes.</p>}
      {error && <p className="audio-error" role="alert">{error}</p>}
      <div className="audio-actions"><button className="secondary-action" onClick={() => close(false)}>{dirty ? 'Discard recording and text' : 'Close'}</button>{running ? <button className="secondary-action" onClick={() => stop()}>Stop transcription</button> : completed ? <button className="primary-action" disabled={!transcript.trim()} onClick={append}>Add to question</button> : <button className="primary-action" disabled={!ready || !audio || loading} onClick={() => void transcribe()}>Transcribe with OpenAI</button>}</div>
      {running && <p role="status">Transcribing… You can stop this request. Charges may still apply to work already started.</p>}
    </DialogContent></Dialog>
    <AlertDialog open={discard} onOpenChange={setDiscard}><AlertDialogContent><AlertDialogTitle>Discard this audio draft?</AlertDialogTitle><AlertDialogDescription>The recording and transcript have not been added to your question. Discarding clears them from this dialog. Any running transcription has been stopped; OpenAI may still bill work already started.</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction onClick={reset}>Discard draft</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>;
}
