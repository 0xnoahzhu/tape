// Test helper: @stoqey/ib's own encoder / decoder / IBApi as the reference implementation for
// differential tests. Loaded with require() so nothing here depends on the package at compile
// time; once @stoqey/ib is removed loadStoqey() returns null and the live comparisons are
// skipped (stored expectations in the fixtures keep being checked).

import { createRequire } from 'node:module';
import type { EventLike } from './normalize.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface StoqeyEncodeResult {
  tokens: unknown[] | null;
  errors: Array<{ message: string; code: number; reqId: number }>;
}

export interface StoqeyRef {
  /** Decodes one frame with @stoqey/ib's Decoder, collecting events like its controller emits them. */
  decode(fields: readonly string[], serverVersion: number): EventLike[];
  /** Runs one @stoqey/ib Encoder call and returns the flattened tokens (as its socket sends them). */
  encode(serverVersion: number, call: (encoder: any) => void): StoqeyEncodeResult;
  /** The package's top-level exports (IBApi, PriceCondition, ...). */
  lib: any;
}

const require = createRequire(import.meta.url);

function flatten(values: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const v of values) {
    if (Array.isArray(v)) out.push(...flatten(v));
    else out.push(v === true || v === false || v instanceof Boolean ? (v.valueOf() ? 1 : 0) : v);
  }
  return out;
}

let cached: StoqeyRef | null | undefined;

export function loadStoqey(): StoqeyRef | null {
  if (cached !== undefined) return cached;
  try {
    const { Decoder } = require('@stoqey/ib/dist/core/io/decoder.js');
    const { Encoder } = require('@stoqey/ib/dist/core/io/encoder.js');
    const lib = require('@stoqey/ib');
    cached = {
      lib,
      decode(fields, serverVersion) {
        const events: EventLike[] = [];
        const decoder = new Decoder({
          serverVersion,
          emitEvent: (name: string, ...args: unknown[]) => events.push({ name, args }),
          // what Controller.emitError / emitInfo turn these into
          emitError: (msg: string, code: number, reqId?: number, adv?: unknown) =>
            events.push({ name: 'error', args: [new Error(msg), code, reqId ?? -1, adv] }),
          emitInfo: (msg: string, code: number) => events.push({ name: 'info', args: [msg, code] }),
        });
        decoder.enqueueMessage([...fields]);
        decoder.process();
        return events;
      },
      encode(serverVersion, call) {
        const result: StoqeyEncodeResult = { tokens: null, errors: [] };
        const encoder = new Encoder({
          serverVersion,
          sendMsg: (...args: unknown[]) => {
            result.tokens = flatten(args);
          },
          emitError: (message: string, code: number, reqId: number) => result.errors.push({ message, code, reqId }),
        });
        call(encoder);
        return result;
      },
    };
  } catch {
    cached = null;
  }
  return cached;
}
