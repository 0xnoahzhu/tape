import { describe, expect, it } from 'vitest';
import { RETIRED_STORAGE_KEYS, removeRetiredKeys } from './retiredKeys';

/** A localStorage stand-in (vitest runs without a DOM). */
function memoryStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  return { data, removeItem: (k: string) => void data.delete(k) };
}

describe('retired storage keys', () => {
  it('removes the dashboard layout and keeps the Positions preferences', () => {
    expect(RETIRED_STORAGE_KEYS).toContain('tape.dash.v1');
    const storage = memoryStorage({ 'tape.dash.v1': '[{"id":"alloc","span":1}]', 'tape.positions.v1': '{"sort":null}' });
    removeRetiredKeys(storage);
    expect([...storage.data.keys()]).toEqual(['tape.positions.v1']);
    // Nothing left to remove: no harm.
    removeRetiredKeys(storage);
    expect(storage.data.size).toBe(1);
  });

  it('survives a storage that refuses access, or none', () => {
    expect(() =>
      removeRetiredKeys({
        removeItem: () => {
          throw new Error('denied');
        },
      }),
    ).not.toThrow();
    expect(() => removeRetiredKeys(null)).not.toThrow();
  });
});
