import { describe, expect, it } from 'vitest';
import { LOCK_HITS, reversed, UNLOCK_HITS } from './clack';

describe('lock sounds', () => {
  it('unlocks high then low, and locks with the same two hits low then high', () => {
    expect(UNLOCK_HITS.map((h) => h.freq)).toEqual([3200, 1900]);
    expect(LOCK_HITS.map((h) => h.freq)).toEqual([1900, 3200]);
  });

  it('keeps each hit and the silence between them, mirrored in time', () => {
    const [low, high] = LOCK_HITS;
    expect(low).toEqual({ ...UNLOCK_HITS[1], at: 0 });
    expect(high).toMatchObject({ freq: 3200, dur: 0.03, gain: 0.55 });
    // Unlock: 3200 Hz ends at 0.03 s, 1900 Hz starts at 0.075 s (0.045 s apart); lock keeps the gap.
    expect(high.at - (low.at + low.dur)).toBeCloseTo(UNLOCK_HITS[1].at - (UNLOCK_HITS[0].at + UNLOCK_HITS[0].dur), 9);
    // Both last as long.
    expect(high.at + high.dur).toBeCloseTo(UNLOCK_HITS[1].at + UNLOCK_HITS[1].dur, 9);
  });

  it('starts at 0 (Web Audio refuses a negative start time) and reverses back to the unlock sound', () => {
    expect(LOCK_HITS[0].at).toBe(0);
    expect(LOCK_HITS.every((h) => h.at >= 0)).toBe(true);
    const back = reversed(LOCK_HITS);
    back.forEach((h, i) => {
      expect(h).toMatchObject({ freq: UNLOCK_HITS[i].freq, dur: UNLOCK_HITS[i].dur, gain: UNLOCK_HITS[i].gain });
      expect(h.at).toBeCloseTo(UNLOCK_HITS[i].at, 9);
    });
  });
});
