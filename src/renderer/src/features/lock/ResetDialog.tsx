// Forgot PIN → "Reset Tape" (design "lk.rs"): explains what is cleared and kept, and asks for the
// word RESET (重置 in Chinese). Main deletes Tape's data and restarts the app.

import { useState } from 'react';
import { RESET_WORDS, resetWordMatches } from '@shared/lock';
import { useLang } from '../../i18n';
import { errorText } from '../../state/orderActions';
import { Button, Modal } from '../../ui/primitives';
import { useLockMessages } from './messages';

export function ResetDialog({ onClose }: { onClose: () => void }) {
  const m = useLockMessages();
  const lang = useLang();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = resetWordMatches(value, lang) && !busy;

  const reset = () => {
    if (!ok) return;
    setBusy(true);
    setError(null);
    // On success the app exits and restarts; the promise only settles when it fails.
    window.tape.resetApp(value).catch((err: unknown) => {
      setBusy(false);
      setError(m.resetFailed(errorText(err)));
    });
  };

  return (
    // The design's panel is 440px wide plus 28px padding on each side (content-box); Modal is border-box.
    <Modal onClose={busy ? undefined : onClose} width={496}>
      {/* data-reset-dialog: the lock screen's key guard leaves the focus here while it is open. */}
      <div data-reset-dialog="" style={{ font: '600 18px/1.2 var(--sans)' }}>
        {m.resetTitle}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--mu)', textWrap: 'pretty' }}>{m.resetDesc}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ width: 52, flexShrink: 0, color: 'var(--r)' }}>{m.clearsLabel}</div>
          <div style={{ color: 'var(--tx)' }}>{m.clears}</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ width: 52, flexShrink: 0, color: 'var(--mu)' }}>{m.keepsLabel}</div>
          <div style={{ color: 'var(--tx)' }}>{m.keeps}</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--dm)' }}>{m.typeToConfirm}</div>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) reset();
          }}
          placeholder={RESET_WORDS[lang]}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          style={{
            height: 40,
            padding: '0 12px',
            border: 'none',
            outline: 'none',
            boxShadow: 'inset 0 0 0 1px var(--ln)',
            background: 'var(--bg)',
            color: 'var(--tx)',
            font: '500 14px/1 var(--mono)',
          }}
        />
      </div>
      {error && <div style={{ fontSize: 12, color: 'var(--r)' }}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Button kind="secondary" onClick={onClose} disabled={busy}>
          {m.cancel}
        </Button>
        {/* Disabled as in the design: the secondary surface with dimmed text, not a faded red. */}
        <Button
          bg={ok ? 'var(--r)' : undefined}
          kind={ok ? 'primary' : 'secondary'}
          onClick={reset}
          disabled={!ok}
          style={ok ? undefined : { opacity: 1, color: 'var(--dm)', boxShadow: 'none', fontWeight: 600 }}
        >
          {busy ? m.resetting : m.reset}
        </Button>
      </div>
    </Modal>
  );
}
