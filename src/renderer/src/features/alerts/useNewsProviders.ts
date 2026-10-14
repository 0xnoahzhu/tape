// The IB login's API news providers for the alert dialog's *New headline* (main asks IB once per
// session, market/news.ts). Asked when the dialog opens and again whenever the connection or its
// session changes; while main is still asking IB, every 2 s.

import { useEffect, useState } from 'react';
import type { NewsProviders } from '@shared/types';
import { useStore } from '../../state/store';

const RETRY_MS = 2_000;

/** The providers, or undefined until main answered. */
export function useNewsProviders(): NewsProviders | undefined {
  const status = useStore((s) => s.connection.status);
  const session = useStore((s) => s.connection.session);
  const [news, setNews] = useState<NewsProviders>();
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () =>
      window.tape.getNewsProviders().then(
        (next) => {
          if (!live) return;
          setNews(next);
          if (next.status === 'loading') timer = setTimeout(() => void ask(), RETRY_MS);
        },
        // Main did not answer (locked, closing): what was shown stays.
        () => undefined,
      );
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [status, session]);
  return news;
}
