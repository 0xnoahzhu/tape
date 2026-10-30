// The data folder ("vault", Settings › Privacy & Security › Data folder): what the user keeps of an
// IB account (watchlists, price alerts, notifications), one folder per account, so the whole folder
// can be backed up, moved or synced to another computer.
//
//   <vault>/tape-vault.json                       marker: { format }
//   <vault>/accounts/<account>/watchlists.json
//   <vault>/accounts/<account>/alerts.json
//   <vault>/accounts/<account>/notifications.json
//
// The user chooses the folder at first launch (there is no default one); where it is, and the account
// it served last, belong to this computer: userData/vault.json.
// Only one computer uses an IB login at a time, so the files are written whole, never merged.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const VAULT_MARKER = 'tape-vault.json';
/** The layout above. A vault of a later format is not opened (an older Tape would write over it). */
export const VAULT_FORMAT = 1;
/** userData file: { path?: the folder the user chose, lastAccount? }. */
export const VAULT_POINTER = 'vault.json';

/**
 * What a folder is to Tape: a vault ('newer': of a later format), empty (or missing) so a vault can
 * be made there, or something else that Tape must not write into.
 */
export type VaultCheck = 'vault' | 'newer' | 'empty' | 'other';

/** IB account ids (U1234567, DU1234567, F1234567 …): letters and digits, so one is a safe folder name. */
export function isAccountId(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9]{1,31}$/.test(s);
}

export function accountDir(vault: string, account: string): string {
  return join(vault, 'accounts', account);
}

export function inspectVault(dir: string): VaultCheck {
  if (!existsSync(dir)) return 'empty';
  if (!statSync(dir).isDirectory()) return 'other';
  const marker = join(dir, VAULT_MARKER);
  if (existsSync(marker)) {
    try {
      const raw = JSON.parse(readFileSync(marker, 'utf8')) as { format?: unknown };
      return typeof raw.format === 'number' && raw.format > VAULT_FORMAT ? 'newer' : 'vault';
    } catch {
      return 'vault';
    }
  }
  // Finder's and the sync clients' own files (.DS_Store, .dropbox …) do not count.
  return readdirSync(dir).some((name) => !name.startsWith('.')) ? 'other' : 'empty';
}

/** Makes `dir` a vault (the marker; account folders come with their first file). */
export function createVault(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, VAULT_MARKER), JSON.stringify({ format: VAULT_FORMAT }, null, 2) + '\n');
}

/**
 * Copies the vault `from` into the empty folder `to`. The marker is written last, so a copy that
 * failed halfway is not taken for a vault.
 */
export function copyVault(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  const accounts = join(from, 'accounts');
  if (existsSync(accounts)) cpSync(accounts, join(to, 'accounts'), { recursive: true, errorOnExist: true, force: false });
  createVault(to);
}
