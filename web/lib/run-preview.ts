import type { Result, RunEvent } from './trio.ts';

export const previewIntervalMs = 50;

/** Coalesce text paints, not stream events. Resets, errors and final results stay immediate. */
export function createRunPreview(paint: (result: Result) => void, schedule: (callback: () => void) => () => void = callback => {
  const timer = setTimeout(callback, previewIntervalMs);
  return () => clearTimeout(timer);
}) {
  let pending: Result | undefined;
  let cancel: (() => void) | undefined;
  let disposed = false;
  let firstDelta = true;
  const flush = () => {
    cancel?.(); cancel = undefined;
    const next = pending; pending = undefined;
    if (!disposed && next) paint(next);
  };
  return {
    update(result: Result, event: RunEvent) {
      if (disposed) return;
      pending = result;
      if (event.type !== 'contribution_delta' || firstDelta) {
        firstDelta = event.type !== 'contribution_delta';
        flush();
      } else if (!cancel) cancel = schedule(flush);
    },
    flush,
    dispose() { disposed = true; cancel?.(); cancel = undefined; pending = undefined; },
  };
}
