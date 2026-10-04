// Framing helpers of the transport (the send queue has its own tests in sendQueue.test.ts).

import { describe, expect, it } from 'vitest';
import { encodeFrame, encodeFrameText, splitFields } from './connection.ts';

describe('framing', () => {
  it('prefixes the UTF-8 byte length and terminates every field with NUL', () => {
    const buf = encodeFrame([81, 9014, 'Café 中']);
    const payload = Buffer.from('81\x009014\0Café 中\0', 'utf8');
    expect(buf.readUInt32BE(0)).toBe(payload.length);
    expect(buf.subarray(4)).toEqual(payload);
  });

  it('sends undefined and null as empty fields', () => {
    expect(encodeFrame([3, undefined, null, 'x']).subarray(4).toString()).toBe('3\0\0\0x\0');
  });

  it('encodes from the frame text in one buffer, identical to the token path', () => {
    const tokens = [3, 11, 265598, 'AAPL', 'Café 中', undefined, 1.5];
    const text = tokens.map((t) => (t == undefined ? '' : String(t))).join('\0');
    expect(encodeFrameText(text)).toEqual(encodeFrame(tokens));
    expect(encodeFrameText('')).toEqual(Buffer.from([0, 0, 0, 1, 0]));
  });

  it('splits NUL-terminated fields, keeping empty ones', () => {
    expect(splitFields('4\x002\x00-1\x002104\x00msg\0\0')).toEqual(['4', '2', '-1', '2104', 'msg', '']);
    expect(splitFields('')).toEqual([]);
    expect(splitFields('no terminator')).toEqual(['no terminator']);
  });
});
