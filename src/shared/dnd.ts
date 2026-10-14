// Do-not-disturb, shared by main (which OS notifications to show) and the renderer (Settings ›
// Notifications, the top bar's indicator).
//
// It always ends by itself: after an hour, or at the next 09:00 in New York (half an hour before
// the US open). There is no "until turned off": a do-not-disturb left on and forgotten would keep
// fills and order updates out of the notification center for good. Critical notifications (an
// order rejected, the connection to IB lost, an option at risk of assignment) come through it.

import { NEW_YORK, zonedParts, zonedToUtc } from './orderTiming';

export type DndChoice = 'hour' | 'morning';
export const DND_CHOICES: readonly DndChoice[] = ['hour', 'morning'];

/** The New York wall time the 'morning' choice ends at. */
export const DND_MORNING = '09:00';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The latest end accepted (from now): the next 09:00 in New York is at most a day away, plus the
 * hour a daylight saving change can add. Longer values (a hand-edited settings.json) are cut to it.
 */
export const DND_MAX_MS = DAY_MS + HOUR_MS;

/** When do-not-disturb started now with this choice ends (Unix ms). */
export function dndEnd(choice: DndChoice, now: number): number {
  if (choice === 'hour') return now + HOUR_MS;
  const today = zonedParts(now, NEW_YORK).ymd;
  const at = zonedToUtc(today, DND_MORNING, NEW_YORK);
  if (at > now) return at;
  // Noon plus a day is tomorrow in New York whatever the daylight saving change.
  const tomorrow = zonedParts(zonedToUtc(today, '12:00', NEW_YORK) + DAY_MS, NEW_YORK).ymd;
  return zonedToUtc(tomorrow, DND_MORNING, NEW_YORK);
}

/** Whether do-not-disturb is on at `now`. */
export function dndActive(n: { dndUntil: number | null }, now: number = Date.now()): boolean {
  return n.dndUntil != null && now < n.dndUntil;
}
