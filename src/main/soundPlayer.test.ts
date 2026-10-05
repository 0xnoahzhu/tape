import { describe, expect, it, vi } from 'vitest';
import { createSoundPlayer, type RunPlayer } from './soundPlayer';

function fakeRun() {
  const runs: Array<{ file: string; kill: ReturnType<typeof vi.fn>; done: (error: Error | null) => void }> = [];
  const run: RunPlayer = (file, done) => {
    const kill = vi.fn(() => true);
    runs.push({ file, kill, done });
    return { kill };
  };
  return { run, runs };
}

describe('createSoundPlayer', () => {
  it('plays the file', () => {
    const { run, runs } = fakeRun();
    createSoundPlayer(run).play('/System/Library/Sounds/Glass.aiff');
    expect(runs.map((r) => r.file)).toEqual(['/System/Library/Sounds/Glass.aiff']);
  });

  it('a new sound stops the one still playing; a finished one is not killed', () => {
    const { run, runs } = fakeRun();
    const player = createSoundPlayer(run);
    player.play('a');
    player.play('b');
    expect(runs[0].kill).toHaveBeenCalledTimes(1);
    runs[1].done(null);
    player.play('c');
    expect(runs[1].kill).not.toHaveBeenCalled();
  });

  it('logs a failure, but not the kill by the next sound', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { run, runs } = fakeRun();
      const player = createSoundPlayer(run);
      player.play('a');
      runs[0].done(Object.assign(new Error('killed'), { killed: true }));
      expect(warn).not.toHaveBeenCalled();
      player.play('b');
      runs[1].done(new Error('no such file'));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
