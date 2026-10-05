// Inline SVG icons from the design.

/** The app mark used in the top bar; colors follow the theme tokens. */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ display: 'block' }} aria-hidden>
      <rect x="1" y="1" width="98" height="98" rx="22.5" style={{ fill: 'var(--bg)', stroke: 'var(--ln)', strokeWidth: 2 }} />
      <path style={{ stroke: 'var(--ln)' }} strokeWidth="1.5" fill="none" d="M12 30H88 M12 50H88 M12 70H88 M30 14V86 M50 14V86 M70 14V86" />
      <path fill="none" style={{ stroke: 'var(--ac)' }} strokeWidth="7" d="M14 70 L28 61 L40 66 L54 46 L66 52 L78 32" />
      <rect x="82" y="22" width="9" height="15" style={{ fill: 'var(--ac)' }} />
    </svg>
  );
}

export function BellIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 18 18" width={size} height={size} style={{ display: 'block' }} aria-hidden>
      <path d="M5 12.5V8a4 4 0 0 1 8 0v4.5h1.5 M3.5 12.5H5 M7.5 15h3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="square" />
    </svg>
  );
}

export function SlidersIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 18 18" width={size} height={size} style={{ display: 'block' }} aria-hidden>
      <path d="M3 5h12 M3 9h12 M3 13h12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="square" />
      <rect x="10" y="3.5" width="3" height="3" style={{ fill: 'var(--p)' }} stroke="currentColor" strokeWidth="1.5" />
      <rect x="5" y="7.5" width="3" height="3" style={{ fill: 'var(--p)' }} stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="11.5" width="3" height="3" style={{ fill: 'var(--p)' }} stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Padlock of the top bar's Lock button. */
export function LockIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 18 18" width={size} height={size} style={{ display: 'block' }} aria-hidden>
      <rect x="3.75" y="8" width="10.5" height="7" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M6 8V5.75a3 3 0 0 1 6 0V8" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

/** Fingerprint of the lock screen's Touch ID / Windows Hello button. */
export function FingerprintIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 18 18" width={size} height={size} style={{ display: 'block' }} aria-hidden>
      <path
        d="M5 14.5c-1-1.5-1.5-3.2-1.5-5a5.5 5.5 0 0 1 11 0 M9 9.5c0 2.2.6 4 1.6 5.5 M6.6 9.5a2.4 2.4 0 0 1 4.8 0c0 1.2.3 2.3.8 3.3 M7.4 15c-.6-1.3-.8-2.9-.8-4.2"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Small unread / active marker dot (square, accent). */
export function Dot({ top, right, size = 6 }: { top: number; right: number; size?: number }) {
  return <div style={{ position: 'absolute', top, right, width: size, height: size, background: 'var(--ac)', boxShadow: '0 0 0 2px var(--p)' }} />;
}

/** Magnifier of the symbol search box. */
export function SearchIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} style={{ display: 'block', flexShrink: 0, color: 'var(--dm)' }} aria-hidden>
      <circle cx="6.75" cy="6.75" r="4.75" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M10.25 10.25 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

/** Double chevron « / »: collapse and expand the watchlist. */
export function DoubleChevronIcon({ dir, size = 18 }: { dir: 'left' | 'right'; size?: number }) {
  const d = dir === 'left' ? 'M9 4.5 L4.5 9 L9 13.5 M13.5 4.5 L9 9 L13.5 13.5' : 'M4.5 4.5 L9 9 L4.5 13.5 M9 4.5 L13.5 9 L9 13.5';
  return (
    <svg viewBox="0 0 18 18" width={size} height={size} style={{ display: 'block' }} aria-hidden>
      <path d={d} stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="square" />
    </svg>
  );
}

/** Plus: add a symbol (drawn, so it centres like the chevrons next to it). */
export function PlusIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 18 18" width={size} height={size} style={{ display: 'block' }} aria-hidden>
      <path d="M9 3.75 V14.25 M3.75 9 H14.25" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="square" />
    </svg>
  );
}
