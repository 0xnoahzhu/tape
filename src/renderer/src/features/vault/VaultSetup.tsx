// The data folder screen: covers the whole window (below the lock screen) while Tape has no usable
// data folder (main/store.ts → VaultState.status): on first launch until one is chosen, and whenever
// the folder in use goes away. Main refuses everything else meanwhile (index.ts → VAULT_METHODS).

import { useState } from 'react';
import { errorText } from '../../state/orderActions';
import { useStore } from '../../state/store';
import { LogoMark } from '../../ui/icons';
import { Button } from '../../ui/primitives';
import { useVaultMessages } from './messages';

export function VaultSetup() {
  const m = useVaultMessages();
  const vault = useStore((s) => s.vault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (task: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    task()
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };
  const choose = () => run(() => window.tape.setVaultFolder('open'));
  const retry = () =>
    run(async () => {
      const next = await window.tape.recheckVaultFolder();
      if (next.status !== 'ok') setError(m.stillGone);
    });

  const unset = vault.status === 'unset';
  const title = unset ? m.setupTitle : vault.status === 'newer' ? m.newerTitle : m.goneTitle;
  const desc = unset ? m.setupDesc : vault.status === 'newer' ? m.newerDesc : m.goneDesc;

  return (
    <div data-vault-setup="" style={{ position: 'absolute', inset: 0, background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      {/* The window can still be dragged by its top edge (the top bar is hidden behind). */}
      <div className="drag" style={{ height: 52, flexShrink: 0 }} />
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px 52px' }}>
        <div style={{ width: 440, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <LogoMark size={48} />
          <div style={{ font: '600 20px/1.2 var(--sans)', color: unset ? 'var(--tx)' : 'var(--r)' }}>{title}</div>
          {!unset && vault.path && (
            <div className="ellipsis" title={vault.path} style={{ font: '13px/1.3 var(--num)', color: 'var(--tx)' }}>
              {vault.path}
            </div>
          )}
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--mu)', textWrap: 'pretty' }}>{desc}</div>
          {unset && <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--dm)', textWrap: 'pretty' }}>{m.setupHint}</div>}
          {error && <div style={{ fontSize: 12, color: 'var(--r)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            {vault.status === 'unavailable' && (
              <Button kind="secondary" onClick={retry} disabled={busy} style={{ flex: 1 }}>
                {m.retry}
              </Button>
            )}
            <Button onClick={choose} disabled={busy} autoFocus style={{ flex: 1 }}>
              {unset ? m.choose : m.chooseOther}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
