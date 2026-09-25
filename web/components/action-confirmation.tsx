'use client';
import { useRef, type ReactNode } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from '@/components/ui/alert-dialog';

/** An explicit UI action, with cancellation and focus restored to its source. */
export function ActionConfirmation({ open, onOpenChange, title, description, confirmLabel, cancelLabel = 'Cancel', destructive = false, disabled = false, onConfirm, onReturnFocus }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: ReactNode; confirmLabel: string; cancelLabel?: string; destructive?: boolean; disabled?: boolean; onConfirm: () => boolean | void; onReturnFocus?: () => void }) {
  const origin = useRef<HTMLElement | null>(null), parentDialog = useRef<HTMLElement | null>(null), confirming = useRef(false);
  // Radix keeps closing content mounted for its exit animation. Keep the last
  // visible decision instead of rendering the caller's cleared-state fallback.
  const presentation = useRef({ title, description, confirmLabel, cancelLabel, destructive });
  if (open) presentation.current = { title, description, confirmLabel, cancelLabel, destructive };
  const shown = presentation.current;
  return <AlertDialog open={open} onOpenChange={onOpenChange}><AlertDialogContent onOpenAutoFocus={() => { origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; parentDialog.current = origin.current?.closest('[role="dialog"]') as HTMLElement | null; confirming.current = false; }} onCloseAutoFocus={event => {
    event.preventDefault();
    if (onReturnFocus) { onReturnFocus(); return; }
    const target = origin.current;
    if (target?.isConnected && !target.matches(':disabled')) target.focus();
    else if (parentDialog.current?.isConnected) parentDialog.current.focus();
  }}><AlertDialogTitle>{shown.title}</AlertDialogTitle><AlertDialogDescription>{shown.description}</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>{shown.cancelLabel}</AlertDialogCancel><AlertDialogAction disabled={disabled || !open} variant={shown.destructive ? 'destructive' : 'default'} onClick={event => {
    event.preventDefault();
    if (!open || disabled || confirming.current) return;
    confirming.current = true;
    if (onConfirm() === false) confirming.current = false;
    else onOpenChange(false);
  }}>{shown.confirmLabel}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}
