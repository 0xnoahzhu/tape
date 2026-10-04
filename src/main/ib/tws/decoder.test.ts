// Differential tests of the decoder. Fixtures hold real frames recorded from IB Gateway
// (server version 193) and hand-built frames in the official field order (176..193); each
// frame stores the events @stoqey/ib's decoder produced for it. This client must produce the
// same events and arguments (compared after normalize(), so class instances, undefined,
// Errors and Maps are compared exactly). While @stoqey/ib is installed its decoder is also run
// live to confirm the stored expectations.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PriceCondition } from './conditions.ts';
import { decodeMessage, decodeUnicodeEscapedString, isDecodedMessage } from './decoder.ts';
import { IN_MSG_ID } from './messageIds.ts';
import { normalize, normalizeEvents, type Normalized } from './__fixtures__/normalize.ts';
import { loadStoqey } from './__fixtures__/stoqeyRef.ts';

interface FixtureFrame {
  label: string;
  tokens: string[];
  serverVersion?: number;
  expected: Normalized;
}

const load = (name: string): { serverVersion?: number; handshake?: string[]; frames: FixtureFrame[] } =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), 'utf8'));

const gateway = load('gateway-193');
const synthetic = load('synthetic');
const stoqey = loadStoqey();

/** Frames whose decoder error texts differ (@stoqey/ib appends its issue tracker URL); only names and codes are compared. */
const TEXT_DIFFERS = new Set(['truncated nextValidId', 'trailing fields']);

/** Event names and arguments, with error messages replaced by a marker. */
const withoutErrorTexts = (events: Normalized): Normalized =>
  JSON.parse(JSON.stringify(events), (key, value) => (key === '$error' ? '<message>' : value));

function check(frame: FixtureFrame, serverVersion: number): void {
  const actual = normalizeEvents(decodeMessage(frame.tokens, serverVersion));
  if (TEXT_DIFFERS.has(frame.label)) expect(withoutErrorTexts(actual)).toStrictEqual(withoutErrorTexts(frame.expected));
  else expect(actual).toStrictEqual(frame.expected);
  if (stoqey) {
    // the stored expectation is still what the installed @stoqey/ib produces
    expect(normalizeEvents(stoqey.decode(frame.tokens, serverVersion))).toStrictEqual(frame.expected);
  }
}

describe('decoder: frames recorded from IB Gateway (server version 193)', () => {
  it('has a server version handshake and frames', () => {
    expect(gateway.serverVersion).toBe(193);
    expect(gateway.handshake?.[0]).toBe('193');
    expect(gateway.frames.length).toBeGreaterThan(100);
  });

  for (const [i, frame] of gateway.frames.entries()) {
    const name = IN_MSG_ID[Number(frame.tokens[0])] ?? frame.tokens[0];
    it(`#${i} ${frame.label} ${name}`, () => check(frame, gateway.serverVersion!));
  }

  it('covers the messages Tape relies on', () => {
    const names = new Set(gateway.frames.flatMap((f) => decodeMessage(f.tokens, 193).map((e) => e.name)));
    for (const n of [
      'managedAccounts',
      'nextValidId',
      'currentTime',
      'info',
      'error',
      'accountSummary',
      'accountSummaryEnd',
      'updateAccountValue',
      'updateAccountTime',
      'accountDownloadEnd',
      'positionEnd',
      'contractDetails',
      'contractDetailsEnd',
      'securityDefinitionOptionParameter',
      'securityDefinitionOptionParameterEnd',
      'symbolSamples',
      'execDetailsEnd',
      'openOrder',
      'orderStatus',
      'openOrderEnd',
      'completedOrder',
      'completedOrdersEnd',
    ]) {
      expect(names, n).toContain(n);
    }
  });
});

describe('decoder: hand-built frames (server versions 176..193)', () => {
  for (const frame of synthetic.frames) {
    it(`${frame.label} @${frame.serverVersion}`, () => check(frame, frame.serverVersion!));
  }
});

describe('decoder: semantics', () => {
  const real = (label: string, id: string) => gateway.frames.find((f) => f.label === label && f.tokens[0] === id)!.tokens;

  it('routes ERR_MSG without a request id to `info` and with one to `error`', () => {
    expect(decodeMessage(['4', '2', '-1', '2104', 'Market data farm connection is OK:usfarm', ''], 193)).toEqual([
      { name: 'info', args: ['Market data farm connection is OK:usfarm', 2104] },
    ]);
    const [e] = decodeMessage(['4', '2', '9022', '162', 'Historical Market Data Service error message', ''], 193);
    expect(e.name).toBe('error');
    expect(e.args[0]).toBeInstanceOf(Error);
    expect((e.args[0] as Error).message).toBe('Historical Market Data Service error message');
    expect(e.args.slice(1)).toEqual([162, 9022, undefined]);
  });

  it('ends historical data with a "finished-<start>-<end>" row', () => {
    const events = decodeMessage(['17', '1', 'S', 'E', '1', '20261001', '1', '2', '0.5', '1.5', '10', '1.2', '3'], 193);
    expect(events.map((e) => e.args)).toEqual([
      [1, '20261001', 1, 2, 0.5, 1.5, 10, 3, 1.2, undefined],
      [1, 'finished-S-E', -1, -1, -1, -1, -1, -1, -1, false],
    ]);
  });

  it('reports the size of ask / last price ticks as tickSize, but not of bid ticks (like @stoqey/ib)', () => {
    expect(decodeMessage(['1', '6', '5', '2', '10.5', '300', '0'], 193).map((e) => [e.name, ...e.args])).toEqual([
      ['tickPrice', 5, 2, 10.5, false],
      ['tickSize', 5, 3, 300],
    ]);
    expect(decodeMessage(['1', '6', '5', '1', '10.4', '200', '1'], 193).map((e) => e.name)).toEqual(['tickPrice']);
  });

  it('decodes order conditions into condition classes', () => {
    const [ev] = decodeMessage(real('placeOrder.condition', '5'), 193);
    const order = ev.args[2] as { conditions: unknown[]; conditionsIgnoreRth: boolean };
    expect(order.conditions[0]).toBeInstanceOf(PriceCondition);
    expect((order.conditions[0] as PriceCondition).strValue).toBe('10000');
    expect(order.conditionsIgnoreRth).toBe(true);
  });

  it('decodes "\\uXXXX" escapes', () => {
    expect(decodeUnicodeEscapedString('Caf\\u00e9 \\u4e2d \\u12')).toBe('Café 中 \\u12');
  });

  it('skips messages outside its scope without events', () => {
    expect(isDecodedMessage(IN_MSG_ID.NEWS_BULLETINS)).toBe(false);
    expect(decodeMessage(['14', '1', '7', '1', 'Exchange is closed', 'NYSE'], 193)).toEqual([]);
    expect(decodeMessage(['999', '1', 'x'], 193)).toEqual([]);
    expect(decodeMessage(['', ''], 193)).toEqual([]);
  });

  it('reports truncated frames as error 505 without emitting partial events', () => {
    const events = decodeMessage(real('contractDetails.AAPL', '10').slice(0, 20), 193);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('error');
    expect(events[0].args.slice(1)).toEqual([505, -1, undefined]);
    expect(decodeMessage([], 193)[0].args[1]).toBe(505);
  });

  it('survives a negative item count', () => {
    expect(decodeMessage(['17', '1', 'S', 'E', '-5'], 193).map((e) => e.args[1])).toEqual(['finished-S-E']);
  });
});

describe('decoder: intentional differences from @stoqey/ib', () => {
  it('reads tickReqParams.minTick as a double (EDecoder), not as an integer', () => {
    const tokens = ['81', '9020', '0.01', '9c0001', '3'];
    expect(decodeMessage(tokens, 193)).toEqual([{ name: 'tickReqParams', args: [9020, 0.01, '9c0001', 3] }]);
    if (stoqey) expect(stoqey.decode(tokens, 193)[0].args[1]).toBe(0);
  });

  it('keeps malformed advancedOrderReject JSON as text instead of throwing', () => {
    const tokens = ['4', '2', '15', '201', 'Order rejected', '{not json'];
    expect(decodeMessage(tokens, 193)[0].args.slice(1)).toEqual([201, 15, '{not json']);
    if (stoqey) expect(() => stoqey.decode(tokens, 193)).toThrow(SyntaxError);
  });

  it('reads the deprecated faProfile of completed orders on server version 176 (EOrderDecoder tests the server version)', () => {
    const frame = gateway.frames.find((f) => f.tokens[0] === '101')!.tokens;
    const FA_PERCENTAGE_AT = 30;
    // server version 176: faProfile after faPercentage, no customerAccount / professionalCustomer
    const at176 = [...frame.slice(0, FA_PERCENTAGE_AT + 1), 'profile', ...frame.slice(FA_PERCENTAGE_AT + 1, -2)];
    const events = decodeMessage(at176, 176);
    expect(events.map((e) => e.name)).toEqual(['completedOrder']);
    const [, order, state] = events[0].args as [unknown, Record<string, unknown>, Record<string, unknown>];
    expect(order.faProfile).toBe('profile');
    expect(order.modelCode).toBe(frame[FA_PERCENTAGE_AT + 1]);
    expect(state.status).toBe('Cancelled');
    if (stoqey) {
      // @stoqey/ib never reads the field here, shifting everything after it
      const theirs = stoqey.decode(at176, 176);
      expect(theirs[0].name).toBe('error');
    }
  });

  it('emits nothing for unknown message ids (@stoqey/ib reports error 505)', () => {
    expect(decodeMessage(['999', '1', 'x'], 193)).toEqual([]);
    if (stoqey) expect(normalize(stoqey.decode(['999', '1', 'x'], 193)[0].args[1])).toBe(505);
  });
});
