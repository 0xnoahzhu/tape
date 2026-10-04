// Wraps the IPC handlers: every invoke resolves to an InvokeResult envelope, and while Tape is
// locked only the methods LOCK_POLICY allows reach their handler. Pure (no Electron) for tests.

import { LOCK_POLICY, LOCKED_MESSAGE, type InvokeResult, type TapeHandlers, type TapeInvokeMethod } from '@shared/ipc';

export type Dispatch = (sender: unknown, args: unknown[]) => Promise<InvokeResult>;

export function createDispatch(method: TapeInvokeMethod, handlers: TapeHandlers, isLocked: () => boolean): Dispatch {
  const fn = handlers[method] as (...args: unknown[]) => unknown;
  return async (sender, args) => {
    if (LOCK_POLICY[method] !== 'allow' && isLocked()) return { ok: false, message: LOCKED_MESSAGE };
    try {
      // Handlers that keep per-renderer state read the sender as `this`.
      return { ok: true, value: await fn.apply(sender, args) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
}
