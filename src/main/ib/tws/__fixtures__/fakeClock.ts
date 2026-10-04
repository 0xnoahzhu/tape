// Test helper: a deterministic Clock (monotonic time + timers) for the send queue.

import type { Clock } from '../sendQueue.ts';

export class FakeClock implements Clock {
  t = 0;
  /** Timers ever scheduled (to check that waiting does not spin). */
  scheduled = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private nextId = 1;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.scheduled++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }

  get pending(): number {
    return this.timers.length;
  }

  /** Advances time, running due timers in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}
