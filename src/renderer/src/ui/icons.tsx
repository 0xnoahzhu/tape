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
