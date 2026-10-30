// Account ids left out of a notification's text while Settings › Privacy & Security hides them
// (appearance.showAccountId false): the bell, the critical toast and the OS notification.
//
// The ids are the ones Tape knows (the login's accounts, the account the data folder serves, the
// notice's own), replaced where they stand as whole words: an account tag ("PAPER DUP899854",
// "实盘 U18630011") keeps PAPER / LIVE alone, as a notice posted while hidden has it, and any other
// mention reads "—". IB's own texts in a notice (a rejection's reason) are covered the same way.

const TAGS = ['PAPER', 'LIVE', '模拟', '实盘'];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function maskAccountIds(text: string, ids: Iterable<string | null | undefined>): string {
  // Longer ids first, so one id that starts another never cuts it.
  const known = [...new Set([...ids].filter((id): id is string => !!id))].sort((a, b) => b.length - a.length);
  if (!known.length) return text;
  const re = new RegExp(`(?:(${TAGS.join('|')}) )?(?<![A-Za-z0-9])(?:${known.map(escape).join('|')})(?![A-Za-z0-9])`, 'g');
  return text.replace(re, (_match, tag: string | undefined) => tag ?? '—');
}
