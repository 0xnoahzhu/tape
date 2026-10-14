// Account id masking (Settings › Appearance › Account ID: Hide) and the PAPER / LIVE account text
// of the dialogs and tags: paper or live is never masked, only the id.

import { useCommon } from '../i18n/common';
import { useStore, type ConfirmRow } from '../state/store';

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

/** "LIVE · U18630011", "PAPER · DUP899854"; "LIVE" alone while account IDs are hidden (or unknown). */
export function accountText(paper: boolean, account: string | undefined, showId: boolean): string {
  const m = useCommon.now();
  return m.accountValue(paper ? m.paperTag : m.liveTag, showId ? (account ?? '') : '');
}

/** A dialog's Account row (the order review, the cancel dialog): live in red. */
export function accountRow(paper: boolean, account: string | undefined, showId: boolean): ConfirmRow {
  const row = { label: useCommon.now().account, value: accountText(paper, account, showId) };
  return paper ? row : { ...row, color: 'var(--r)' };
}
