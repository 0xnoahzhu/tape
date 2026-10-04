// Request/response plumbing shared by the market data services: one-shot IB requests with
// timeouts, error classification, a TTL cache with in-flight de-duplication and a
// concurrency limiter.

import { EventName, type IBApi } from '../ib/tws';
import type { IbListener, MainContext, Unsubscribe } from '../context';

/** An error reported by IB for one request (error callback with a reqId). */
export class IbRequestError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`${message} (IB ${code})`);
    this.name = 'IbRequestError';
    this.code = code;
  }
}

export const NOT_CONNECTED = 'Not connected to IB Gateway / TWS';

/**
 * Codes that IB reports with a reqId but that do not end the request: 21xx are notices
 * (e.g. 2152 depth permissions, 2176 fractional size rules), 10167 means delayed data is shown
 * instead of live, 10090 means only part of the requested ticks are subscribed and 10091 that
 * part of them needs an additional API subscription (delayed data is shown for those).
 */
export function isWarningCode(code: number): boolean {
  return (code >= 2100 && code < 2200) || code === 10167 || code === 10090 || code === 10091;
}

/** Longest a request may wait in the send queue (behind IB's pacing rules) before it times out. */
export const MAX_QUEUE_WAIT_MS = 11 * 60_000;

/** True when the API socket is up and the handshake is done. */
export function isIbConnected(ctx: MainContext): boolean {
  return !!ctx.ib.api && ctx.ib.isConnected();
}

export function requireApi(ctx: MainContext): IBApi {
  const api = ctx.ib.api;
  if (!api || !ctx.ib.isConnected()) throw new Error(NOT_CONNECTED);
  return api;
}

export interface RequestControls<T> {
  resolve(value: T): void;
  reject(err: Error): void;
}

export interface RequestSpec<T> {
  /** Human-readable request name used in timeout messages, e.g. "Contract details for AAPL". */
  label: string;
  timeoutMs: number;
  send(api: IBApi, reqId: number): void;
  /** Cancels the request at IB when it times out (e.g. cancelHistoricalData). */
  cancel?(api: IBApi, reqId: number): void;
  /**
   * Handlers per IB event; each is called only for this request's reqId (the first callback
   * argument) and receives the remaining arguments.
   */
  events: Record<string, (args: unknown[], ctl: RequestControls<T>) => void>;
  /** Custom handling of a request error; return true when handled (resolved or rejected). */
  onError?(e: { code: number; message: string }, ctl: RequestControls<T>): boolean;
  /** Aborting sends cancel() (when the request was sent) and rejects with the signal's reason. */
  signal?: AbortSignal;
  /**
   * Outgoing message id of the request. When set, `timeoutMs` counts from the moment the frame
   * is written (the send queue holds paced requests such as historical data until IB's rules
   * allow them), and the wait before that is bounded by MAX_QUEUE_WAIT_MS.
   */
  timeoutFromWrite?: number;
}

/**
 * Sends one IB request and resolves with its response. Rejects with an IbRequestError when IB
 * reports an error for the reqId, with a readable Error on timeout or when the socket closes.
 */
export function ibRequest<T>(ctx: MainContext, spec: RequestSpec<T>): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let api: IBApi;
    try {
      api = requireApi(ctx);
    } catch (err) {
      rejectPromise(err as Error);
      return;
    }
    const signal = spec.signal;
    if (signal?.aborted) {
      rejectPromise(abortReason(signal));
      return;
    }
    const reqId = ctx.ib.nextReqId();
    const subs: Unsubscribe[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      for (const off of subs) off();
    };
    const ctl: RequestControls<T> = {
      resolve(value) {
        if (settled) return;
        finish();
        resolvePromise(value);
      },
      reject(err) {
        if (settled) return;
        finish();
        rejectPromise(err);
      },
    };
    /** Cancels the request at IB (an unsent request and its cancel never reach the wire). */
    const cancelAtIb = () => {
      try {
        if (spec.cancel && ctx.ib.api) spec.cancel(ctx.ib.api, reqId);
      } catch {
        // The socket may already be gone; the request is over either way.
      }
    };

    for (const [event, handler] of Object.entries(spec.events)) {
      const listener: IbListener = (id: unknown, ...rest: unknown[]) => {
        if (settled || id !== reqId) return;
        try {
          handler(rest, ctl);
        } catch (err) {
          ctl.reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      subs.push(ctx.ib.on(event, listener));
    }
    subs.push(
      ctx.ib.onRequestError((e) => {
        if (settled || e.reqId !== reqId) return;
        if (spec.onError?.(e, ctl)) return;
        if (isWarningCode(e.code)) return;
        ctl.reject(new IbRequestError(e.code, e.message));
      }),
    );
    subs.push(ctx.ib.onClosed(() => ctl.reject(new Error(`${spec.label}: connection closed`))));
    if (signal) {
      const onAbort = () => {
        if (settled) return;
        cancelAtIb();
        ctl.reject(abortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      subs.push(() => signal.removeEventListener('abort', onAbort));
    }

    const startTimer = (ms: number, what: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        cancelAtIb();
        ctl.reject(new Error(`${spec.label} ${what} after ${Math.round(ms / 1000)} s`));
      }, ms);
    };
    const msgId = spec.timeoutFromWrite;
    if (msgId === undefined) {
      startTimer(spec.timeoutMs, 'timed out');
    } else {
      // The response timeout starts when the frame is on the wire (the 'sent' event of the client).
      startTimer(MAX_QUEUE_WAIT_MS, 'was not sent (IB pacing)');
      const offSent = ctx.ib.on(EventName.sent, (tokens: unknown) => {
        if (settled || !Array.isArray(tokens) || Number(tokens[0]) !== msgId || Number(tokens[1]) !== reqId) return;
        offSent();
        startTimer(spec.timeoutMs, 'timed out');
      });
      subs.push(offSent);
    }

    try {
      spec.send(api, reqId);
    } catch (err) {
      ctl.reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

/**
 * Caches successful results for a time-to-live and shares in-flight loads, so concurrent
 * callers asking for the same key trigger one request. Failures are never cached.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(private readonly now: () => number = Date.now) {}

  peek(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (ttlMs > 0) this.entries.set(key, { value, expires: this.now() + ttlMs });
  }

  get(key: string, ttlMs: number | ((value: V) => number), load: () => Promise<V>): Promise<V> {
    const e = this.entries.get(key);
    if (e && e.expires > this.now()) return Promise.resolve(e.value);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = load().then(
      (value) => {
        this.inflight.delete(key);
        this.set(key, value, typeof ttlMs === 'function' ? ttlMs(value) : ttlMs);
        return value;
      },
      (err: unknown) => {
        this.inflight.delete(key);
        throw err;
      },
    );
    this.inflight.set(key, p);
    return p;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Runs at most `max` async tasks at a time; the rest wait in FIFO order. */
export class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        let p: Promise<T>;
        try {
          p = task();
        } catch (err) {
          p = Promise.reject(err);
        }
        p.then(resolve, reject).finally(() => {
          this.active--;
          this.queue.shift()?.();
        });
      };
      if (this.active < this.max) start();
      else this.queue.push(start);
    });
  }
}

/** Runs `fn` once all services have been constructed (they reach each other lazily). */
export function afterStartup(fn: () => void): void {
  setImmediate(fn);
}
