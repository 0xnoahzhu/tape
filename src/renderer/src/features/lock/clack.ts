// The lock sounds from the design: a synthesized two-part "clack" (band-passed noise bursts with a
// falling sine underneath), so no audio file ships with the app. Unlocking plays the high hit, then
// the low one; locking plays the same pair backwards (low, then high).

/** One part of the clack: `at` seconds after the start, around `freq` Hz, `dur` seconds long. */
export interface Hit {
  at: number;
  freq: number;
  dur: number;
  gain: number;
}

export const UNLOCK_HITS: readonly Hit[] = [
  { at: 0, freq: 3200, dur: 0.03, gain: 0.55 },
  { at: 0.075, freq: 1900, dur: 0.05, gain: 0.8 },
];

/** The hits mirrored in time: the last one starts first, the gap between them is kept. */
export function reversed(hits: readonly Hit[]): Hit[] {
  const end = Math.max(...hits.map((h) => h.at + h.dur));
  return hits.map((h) => ({ ...h, at: end - (h.at + h.dur) })).sort((a, b) => a.at - b.at);
}

export const LOCK_HITS: readonly Hit[] = reversed(UNLOCK_HITS);

let ctx: AudioContext | null = null;

function play(hits: readonly Hit[]): void {
  try {
    const C = (ctx ??= new AudioContext());
    void C.resume();
    const t0 = C.currentTime;
    for (const { at, freq, dur, gain } of hits) {
      const len = Math.floor(C.sampleRate * dur);
      const buffer = C.createBuffer(1, len, C.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
      const noise = C.createBufferSource();
      noise.buffer = buffer;
      const bp = C.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = 4;
      const g = C.createGain();
      g.gain.value = gain;
      noise.connect(bp);
      bp.connect(g);
      g.connect(C.destination);
      noise.start(t0 + at);

      const osc = C.createOscillator();
      const og = C.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq / 3, t0 + at);
      osc.frequency.exponentialRampToValueAtTime(freq / 6, t0 + at + dur);
      og.gain.setValueAtTime(gain * 0.5, t0 + at);
      og.gain.exponentialRampToValueAtTime(0.001, t0 + at + dur);
      osc.connect(og);
      og.connect(C.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + dur + 0.02);
    }
  } catch {
    // No audio output: lock and unlock silently.
  }
}

/** Unlocked (the lock screen's success animation). */
export const clack = (): void => play(UNLOCK_HITS);

/** Locked (`state/lockActions.ts`, whatever locked Tape). */
export const lockClack = (): void => play(LOCK_HITS);
