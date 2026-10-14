// Rolling price windows for the 3 / 5-minute change alerts (pure, unit-tested). IB has no tick for a
// price change over minutes (ticks 63–65 are volumes), so main keeps the live price of each
// instrument with such an alert: at most one sample per second (the second's last price), for
// WINDOW_KEEP_MS. The change over N minutes is against the newest sample at or before N minutes
// ago, i.e. the price then (moomoo's definition), not the window's low or high.
//
// A window counts only while it is continuous: it starts over (`since`) on a disconnect or
// reconnect, a quote error, and whenever the quote is not live (delayed or frozen data says nothing
// about the last minutes), so nothing fires right after (re)subscribing.

/** Longest window (5 minutes) plus a minute of slack. */
export const WINDOW_KEEP_MS = 6 * 60_000;

export interface PriceWindow {
  /** Ascending, one per second. */
  samples: Array<{ t: number; price: number }>;
  /** Time of the first sample since the window last started over; undefined while empty. */
  since?: number;
}

export function createWindow(): PriceWindow {
  return { samples: [] };
}

/** Starts the window over (the samples before a gap say nothing about the minutes since). */
export function resetWindow(w: PriceWindow): void {
  w.samples = [];
  w.since = undefined;
}

/** Records the live price at `t` (ms); within the same second it replaces that second's sample. */
export function addSample(w: PriceWindow, t: number, price: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  const last = w.samples[w.samples.length - 1];
  if (last && Math.floor(last.t / 1000) === Math.floor(t / 1000)) {
    last.price = price;
    last.t = t;
  } else if (!last || t > last.t) {
    w.samples.push({ t, price });
  }
  w.since ??= t;
  // Keep one sample at or before the oldest moment a window can reach back to.
  while (w.samples.length >= 2 && w.samples[1].t <= t - WINDOW_KEEP_MS) w.samples.shift();
}

/** The price at `t`: the newest sample at or before it (undefined when the window does not reach back that far). */
function priceAt(w: PriceWindow, t: number): number | undefined {
  for (let i = w.samples.length - 1; i >= 0; i--) if (w.samples[i].t <= t) return w.samples[i].price;
  return undefined;
}

/**
 * Change in percent of the newest price against the price `minutes` ago, at `now` (ms); undefined
 * while the window has not been continuous for that long.
 */
export function windowChange(w: PriceWindow, minutes: number, now: number): number | undefined {
  const span = minutes * 60_000;
  if (w.since === undefined || w.since > now - span || !w.samples.length) return undefined;
  const ref = priceAt(w, now - span);
  const cur = w.samples[w.samples.length - 1].price;
  return ref ? (cur / ref - 1) * 100 : undefined;
}

/** Milliseconds until the window covers `minutes` (0: it does), for the "waiting" status. */
export function windowWait(w: PriceWindow, minutes: number, now: number): number {
  if (w.since === undefined) return minutes * 60_000;
  return Math.max(0, w.since + minutes * 60_000 - now);
}
