import { useEffect, useState } from 'react';

/** Current time, refreshed every `intervalMs` (market session badge, live bar checks). */
export function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
