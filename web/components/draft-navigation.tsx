import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { useSidebar } from '@/components/ui/sidebar';
import { Plus } from 'lucide-react';

export type DraftDestination = { type: 'new' } | { type: 'session'; id: string };

export function NewSessionButton({ busy, onRequest }: { busy: boolean; onRequest: () => void }) {
  const { setOpenMobile } = useSidebar();
  return <button className="new-session" disabled={busy} onClick={() => { setOpenMobile(false); onRequest(); }}><Plus size={17} /> New session <span>↗</span></button>;
}

export function DraftNavigation({ destination, onCancel, onDiscard, onFocus }: { destination: DraftDestination | null; onCancel: () => void; onDiscard: () => void; onFocus: () => void }) {
  return <AlertDialog open={destination !== null} onOpenChange={open => { if (!open) onCancel(); }}><AlertDialogContent onCloseAutoFocus={event => { event.preventDefault(); onFocus(); }}><AlertDialogTitle>Discard the current draft?</AlertDialogTitle><AlertDialogDescription>Your unsent question and attached files will be cleared. Instructions for a new, unsaved conversation will also be cleared. Saved conversations stay intact. Keep editing to review or copy your draft first.</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={onDiscard}>{destination?.type === 'new' ? 'Discard and start new' : 'Discard and switch'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}
