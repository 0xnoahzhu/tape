// Tape's own update, from the renderer: check now, and restart into a downloaded version after a
// confirmation (it closes the connection to TWS / IB Gateway, so it arms like a disconnect).

import type { UpdateState } from '@shared/types';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { useUpdateMessages } from './messages';

/** GitHub release page of a version (the publish setting in electron-builder.yml). */
export const releaseUrl = (version: string): string => `https://github.com/0xnoahzhu/tape/releases/tag/v${version}`;

/** The new version waiting for the user (available, or downloaded): the Settings button's dot. */
export const updatePending = (u: UpdateState): string | null => (u.status === 'available' || u.status === 'ready' ? u.version : null);

const toastError = (err: unknown) => useStore.getState().showToast(errorText(err), 'error');

export function downloadUpdate(): void {
  window.tape.downloadUpdate().catch(toastError);
}

export function checkForUpdates(): void {
  window.tape.checkForUpdates().catch(toastError);
}

/** Asks before restarting into the downloaded version. */
export function confirmInstallUpdate(): void {
  const s = useStore.getState();
  if (s.update.status !== 'ready') return;
  const m = useUpdateMessages.now();
  const connected = s.connection.status === 'connected';
  s.ask({
    title: m.confirmTitle,
    rows: [
      { label: m.current, value: s.appVersion },
      { label: m.next, value: s.update.version },
    ],
    note: m.confirmNote,
    warnings: connected ? [m.confirmConnected] : undefined,
    label: m.confirmLabel,
    danger: connected,
    run: () => window.tape.installUpdate().catch(toastError),
  });
}
