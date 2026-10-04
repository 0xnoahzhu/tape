// Minimal, type-safe i18n. Each feature declares its own messages next to its code:
//
//   const useM = createMessages({
//     en: { buy: 'Buy', shares: (n: number) => `${n} sh` },
//     zh: { buy: '买入', shares: (n: number) => `${n} 股` },
//   });
//   const m = useM(); m.buy; m.shares(100);   // inside components
//   useM.now().buy                            // outside React (store actions, callbacks)
//
// The `zh` table must provide every key of `en` with the same type.

import { createClock, type Clock } from '@shared/timeFormat';
import type { Lang, LocalizedName } from '@shared/types';
import { useStore } from '../state/store';

type Messages = Record<string, unknown>;

export interface MessagesHook<T> {
  (): T;
  /** Messages for the current language, for use outside React render. */
  now(): T;
  /** Messages for a specific language. */
  for(lang: Lang): T;
}

export function createMessages<T extends Messages>(tables: { en: T; zh: { [K in keyof T]: T[K] } }): MessagesHook<T> {
  const pick = (lang: Lang): T => (lang === 'zh' ? (tables.zh as T) : tables.en);
  const hook = (() => pick(useStore((s) => s.settings.appearance.language))) as MessagesHook<T>;
  hook.now = () => pick(currentLang());
  hook.for = pick;
  return hook;
}

export function useLang(): Lang {
  return useStore((s) => s.settings.appearance.language);
}

export function currentLang(): Lang {
  return useStore.getState().settings.appearance.language;
}

/**
 * Clock times in the user's format (Settings › General › Time format) and language. Components
 * that show times re-render when either changes, so every open view follows the setting live.
 */
export function useClock(): Clock {
  const lang = useLang();
  const format = useStore((s) => s.settings.appearance.timeFormat);
  return createClock(format, lang);
}

/** The clock of the current settings, for use outside React render. */
export function currentClock(): Clock {
  const a = useStore.getState().settings.appearance;
  return createClock(a.timeFormat, a.language);
}

/** Resolves a built-in localized name or returns a user-defined string as is. */
export function nameOf(name: LocalizedName | undefined, lang: Lang): string {
  if (name == null) return '';
  return typeof name === 'string' ? name : name[lang];
}
