// Account id masking (Settings › Appearance › Account ID: Hide).

import { useStore } from '../state/store';

// Live (U1234567), paper (DU…, DUP…, DF…) and advisor (F…) account ids.
const ACCOUNT_RE = /\b(D[A-Z]{1,2}|U|F)\d{5,}\b/g;

/** Replaces IB account ids (DU1234567, U1234567 …) with "—" unless shown. */
export function maskAccounts(text: string, show: boolean): string {
  return show ? text : text.replace(ACCOUNT_RE, '—');
}

/** The active account id, or "—" when hidden / unknown. */
export function useAccountId(): string {
  const show = useStore((s) => s.settings.appearance.showAccountId);
  const acct = useStore((s) => s.connection.account ?? s.account?.account ?? '');
  if (!acct) return '—';
  return show ? acct : '—';
}
