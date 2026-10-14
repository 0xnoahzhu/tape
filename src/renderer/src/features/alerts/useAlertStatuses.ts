// Whether main is watching each alert, with the values it measured. Main sends an `alertStatuses`
// event when a state changes (the store mirrors it); the measured values move with every quote, so a
// view that shows them (the bell's list, the edit dialog) polls getAlertStatuses while it is open.

import { useEffect, useMemo, useState } from 'react';
import type { AlertStatus } from '@shared/types';
import { useStore } from '../../state/store';

/** How often an open view asks main for current values. */
export const ALERT_STATUS_POLL_MS = 2_000;

/** Statuses by alert id: the newer of the last event and, with `poll`, the last poll. */
export function useAlertStatuses(poll: boolean): Map<string, AlertStatus> {
  const pushed = useStore((s) => s.alertStatuses);
  const [pushedAt, setPushedAt] = useState(() => Date.now());
  const [polled, setPolled] = useState<{ at: number; list: AlertStatus[] } | null>(null);
  useEffect(() => setPushedAt(Date.now()), [pushed]);
  useEffect(() => {
    if (!poll) return;
    let live = true;
    const ask = () =>
      window.tape.getAlertStatuses().then(
        (list) => {
          if (live) setPolled({ at: Date.now(), list });
        },
        // Nothing to show instead: the event's statuses stay.
        () => undefined,
      );
    void ask();
    const t = setInterval(() => void ask(), ALERT_STATUS_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [poll]);
  return useMemo(() => {
    const list = polled && poll && polled.at >= pushedAt ? polled.list : pushed;
    return new Map(list.map((s) => [s.id, s]));
  }, [polled, poll, pushed, pushedAt]);
}
