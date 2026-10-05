// Plays a notification sound file (macOS: /usr/bin/afplay, see notificationSound.ts for why Tape
// plays it instead of the notification). One sound at a time: a new one stops the one still
// playing, so a burst of fills is one sound, not a pile-up.

import { execFile, type ChildProcess } from 'node:child_process';

export type RunPlayer = (file: string, done: (error: Error | null) => void) => Pick<ChildProcess, 'kill'>;

const afplay: RunPlayer = (file, done) => execFile('/usr/bin/afplay', [file], { timeout: 10_000 }, (error) => done(error));

export interface SoundPlayer {
  play(file: string): void;
}

export function createSoundPlayer(run: RunPlayer = afplay): SoundPlayer {
  let current: Pick<ChildProcess, 'kill'> | null = null;
  let playing = 0;
  return {
    play(file) {
      current?.kill();
      current = null;
      const id = ++playing;
      const child = run(file, (error) => {
        if (id === playing) current = null;
        // A kill by the next sound is expected; anything else is worth a line in the log.
        if (error && !(error as { killed?: boolean }).killed) console.warn('[notifications] sound failed:', error.message);
      });
      if (id === playing) current = child;
    },
  };
}
