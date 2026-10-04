// Cached one-shot IPC requests (option chain parameters, history) shared by the desk's
// components. Results are kept for the session; failures and empty results are retried
// when the connection comes back. Entries can be seeded for development captures.

import { useEffect, useSyncExternalStore } from 'react';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';

export interface RequestEntry<T> {
  data?: T;
  error?: string;
  pending?: boolean;
  /** Seeded through the debug handle: never refetched. */
  seeded?: boolean;
  at: number;
}

const cache = new Map<string, RequestEntry<unknown>>();
/** Bumped by retryRequest to re-run a request whose inputs did not change. */
const nonces = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version++;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function seedRequest<T>(key: string, data: T): void {
  cache.set(key, { data, seeded: true, at: Date.now() });
  emit();
}

/** Drops a cached result and asks mounted users to fetch it again. */
export function retryRequest(key: string): void {
  cache.delete(key);
  nonces.set(key, (nonces.get(key) ?? 0) + 1);
  emit();
}

/** Minimum delay between attempts for a failed or empty request. */
const RETRY_MS = 5_000;

/**
 * Runs `fetcher` once per `key` (null = idle) and returns the cached entry. Successful,
 * non-empty results stay fresh for `ttlMs`; other results are retried when the
 * connection state changes.
 */
export function useCachedRequest<T>(key: string | null, fetcher: () => Promise<T>, ttlMs: number, isEmpty: (d: T) => boolean = () => false): RequestEntry<T> | undefined {
  const connected = useStore((s) => s.connection.status === 'connected');
  useSyncExternalStore(subscribe, () => version);
  const nonce = key ? (nonces.get(key) ?? 0) : 0;

  useEffect(() => {
    if (!key) return;
    const e = cache.get(key) as RequestEntry<T> | undefined;
    const now = Date.now();
    if (e?.pending || e?.seeded) return;
    const good = e?.data !== undefined && !e.error && !isEmpty(e.data);
    if (e && good && now - e.at < ttlMs) return;
    if (e && !good && now - e.at < RETRY_MS) return;
    cache.set(key, { ...e, pending: true, at: e?.at ?? 0 });
    emit();
    fetcher().then(
      (data) => {
        if (cache.get(key)?.seeded) return;
        cache.set(key, { data, at: Date.now() });
        emit();
      },
      (err: unknown) => {
        if (cache.get(key)?.seeded) return;
        cache.set(key, { data: e?.data, error: errorText(err), at: Date.now() });
        emit();
      },
    );
    // The fetcher is keyed by `key`; re-run only when the key, connection or nonce changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected, nonce]);

  return key ? (cache.get(key) as RequestEntry<T> | undefined) : undefined;
}
