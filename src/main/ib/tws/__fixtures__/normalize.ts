// Test helper: turns decoded events into plain JSON so they can be compared with each other
// and stored in fixtures without losing information. Class instances become plain objects
// tagged with their class name; undefined, non-finite numbers, Errors and Maps become tagged
// objects ({ $undefined }, { $num }, { $error }, { $map }); object keys are sorted.

export type Normalized = null | boolean | number | string | Normalized[] | { [key: string]: Normalized };

export interface EventLike {
  name: string;
  args: readonly unknown[];
}

export function normalize(value: unknown): Normalized {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $num: String(value) };
  if (typeof value === 'bigint') return { $bigint: String(value) };
  if (value instanceof Error) return { $error: value.message };
  if (value instanceof Map) return { $map: [...value.entries()].map(([k, v]) => [normalize(k), normalize(v)]) };
  if (Array.isArray(value)) {
    const out: Normalized[] = [];
    for (let i = 0; i < value.length; i++) out.push(normalize(value[i])); // holes -> $undefined
    return out;
  }
  if (typeof value === 'object') {
    const out: { [key: string]: Normalized } = {};
    const proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype) out.$class = (proto.constructor as { name?: string } | undefined)?.name ?? '?';
    for (const key of Object.keys(value).sort()) out[key] = normalize((value as Record<string, unknown>)[key]);
    return out;
  }
  return { $unsupported: typeof value };
}

export const normalizeEvents = (events: readonly EventLike[]): Normalized =>
  events.map((e) => ({ name: e.name, args: e.args.map(normalize) }));
