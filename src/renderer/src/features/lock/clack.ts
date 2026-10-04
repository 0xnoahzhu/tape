// The unlock sound from the design: a synthesized two-part "clack" (band-passed noise bursts with a
// falling sine underneath), so no audio file ships with the app.

let ctx: AudioContext | null = null;

export function clack(): void {
  try {
    const C = (ctx ??= new AudioContext());
    void C.resume();
    const t0 = C.currentTime;
    const hit = (at: number, freq: number, dur: number, gain: number) => {
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
    };
    hit(0, 3200, 0.03, 0.55);
    hit(0.075, 1900, 0.05, 0.8);
  } catch {
    // No audio output: unlock silently.
  }
}
