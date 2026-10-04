// Strings shown by the main process (menus, OS notifications). Mirrors the renderer's
// createMessages: each module declares its own tables next to its code.
//
//   const m = createMessages({ en: { quit: 'Quit' }, zh: { quit: '<Chinese>' } });
//   m(lang).quit;                       // one language (menus)
//   m.both((t) => t.quit);              // LocalizedText for AppNotification title/body
//
// The `zh` table must provide every key of `en` with the same type.

import type { Lang, LocalizedText } from '@shared/types';

export interface MainMessages<T> {
  (lang: Lang): T;
  /** Builds a LocalizedText from the same message in both languages. */
  both(pick: (messages: T) => string): LocalizedText;
}

export function createMessages<T extends Record<string, unknown>>(tables: { en: T; zh: { [K in keyof T]: T[K] } }): MainMessages<T> {
  const pick = ((lang: Lang): T => (lang === 'zh' ? (tables.zh as T) : tables.en)) as MainMessages<T>;
  pick.both = (fn) => ({ en: fn(tables.en), zh: fn(tables.zh as T) });
  return pick;
}
