// The six 40×48 PIN cells over a hidden input (lock screen and PIN dialogs). The PIN is any six
// characters, so the input is a password field: no IME, autocomplete, spellcheck or capitalization,
// and the system keyboard stays the full one. Typing or pasting keeps at most six characters.
//
// The PIN is case-sensitive and the input is invisible (so is Chromium's own Caps Lock sign), so the
// Caps Lock state is reported to the caller. A dead key (macOS Option+E, then E → é) first inserts a
// provisional accent as composition text: nothing is reported until the composition is committed,
// so a provisional sixth character never submits the PIN.

import { useRef, useState, type Ref } from 'react';
import { cellLook, pinInput, pinLength, PIN_LENGTH } from './model';

interface Props {
  value: string;
  /** `rejected`: whitespace or control characters were dropped (callers show a hint). */
  onChange(value: string, rejected: boolean): void;
  error?: boolean;
  /** The unlock animation: cells fill with the accent, 45 ms apart. */
  success?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Accessible name of the input. */
  label: string;
  reducedMotion?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** Caps Lock was found on or off (on key presses and clicks). */
  onCapsLock?(on: boolean): void;
}

export function PinCells({ value, onChange, error = false, success = false, disabled, autoFocus, label, reducedMotion, inputRef, onCapsLock }: Props) {
  const t = reducedMotion ? 'none' : undefined;
  /** What the input shows while a composition is in progress (null: not composing). */
  const [draft, setDraft] = useState<string | null>(null);
  const composing = useRef(false);
  const length = pinLength(draft == null ? value : pinInput(draft).value);

  const commit = (raw: string) => {
    const next = pinInput(raw);
    onChange(next.value, next.rejected);
  };
  // Key and mouse events carry the modifier state (a focus event does not).
  const caps = (e: { getModifierState(key: string): boolean }) => onCapsLock?.(e.getModifierState('CapsLock'));
  return (
    <div style={{ position: 'relative', display: 'flex', gap: 10, opacity: disabled && !success ? 0.5 : 1 }}>
      {Array.from({ length: PIN_LENGTH }, (_, i) => {
        const c = cellLook(i, length, { error, success, disabled });
        return (
          <div
            key={i}
            style={{
              width: 40,
              height: 48,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: c.bg,
              boxShadow: `inset 0 0 0 1px ${c.border}`,
              transition: t ?? `background .18s ease ${c.delay}, box-shadow .18s ease ${c.delay}`,
            }}
          >
            <div
              style={{
                width: 10,
                height: 10,
                background: c.dot,
                transform: `scale(${c.scale})`,
                transition: t ?? `transform .18s ease ${c.delay}, background .18s ease ${c.delay}`,
              }}
            />
          </div>
        );
      })}
      <input
        ref={inputRef}
        type="password"
        value={draft ?? value}
        onChange={(e) => {
          if (composing.current || (e.nativeEvent as InputEvent).isComposing) return void setDraft(e.target.value);
          commit(e.target.value);
        }}
        onCompositionStart={(e) => {
          composing.current = true;
          setDraft(e.currentTarget.value);
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          setDraft(null);
          commit(e.currentTarget.value);
        }}
        onKeyDown={caps}
        onKeyUp={caps}
        onMouseDown={caps}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-label={label}
        data-pin-input=""
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          opacity: 0,
          border: 'none',
          padding: 0,
          cursor: disabled ? 'not-allowed' : 'pointer',
          caretColor: 'transparent',
        }}
      />
    </div>
  );
}
