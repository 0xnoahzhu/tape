// Lock screen helpers shared by main and the renderer.

import type { Lang } from './types';

// ---------------------------------------------------------------------------
// PIN rule: exactly six characters of any kind (letters are case-sensitive; digits, symbols and
// other scripts are fine), NFC-normalized and counted in Unicode code points. Whitespace and
// control / format characters are refused: they are invisible in the cells and easy to mistype.

export const PIN_LENGTH = 6;

/** Whitespace, control (Cc), format (Cf, e.g. zero-width) and lone surrogate (Cs) code points. */
const FORBIDDEN = /[\p{White_Space}\p{Cc}\p{Cf}\p{Cs}]/u;
const FORBIDDEN_ALL = /[\p{White_Space}\p{Cc}\p{Cf}\p{Cs}]/gu;

/** The PIN as it is hashed and compared: NFC, so é typed as one or two code points is the same PIN. */
export const normalizePin = (pin: string): string => pin.normalize('NFC');

/** Length in code points (an emoji counts once, as in the cells). */
export const pinLength = (pin: string): number => [...pin].length;

/** Whether `pin` (after NFC) is six allowed characters. */
export function isValidPin(pin: unknown): pin is string {
  if (typeof pin !== 'string') return false;
  const p = normalizePin(pin);
  return pinLength(p) === PIN_LENGTH && !FORBIDDEN.test(p);
}

/**
 * What the hidden PIN input keeps of what was typed or pasted: NFC, without whitespace and control
 * characters (`rejected` says some were dropped, for the hint), cut to six characters.
 */
export function pinInput(raw: string): { value: string; rejected: boolean } {
  const normalized = normalizePin(raw);
  const allowed = normalized.replace(FORBIDDEN_ALL, '');
  return { value: [...allowed].slice(0, PIN_LENGTH).join(''), rejected: allowed !== normalized };
}

// ---------------------------------------------------------------------------
// Forgot PIN

/** The word to type in the Forgot-PIN dialog to confirm a reset. */
export const RESET_WORDS: Readonly<Record<Lang, string>> = { en: 'RESET', zh: '重置' };

/** Whether `input` confirms a reset in `lang` (trimmed, case-insensitive). */
export function resetWordMatches(input: string, lang: Lang): boolean {
  return typeof input === 'string' && input.trim().toUpperCase() === RESET_WORDS[lang];
}

/** Main accepts the word of either language (the language may change while the dialog is open). */
export function isResetConfirmation(input: unknown): boolean {
  return typeof input === 'string' && (resetWordMatches(input, 'en') || resetWordMatches(input, 'zh'));
}
