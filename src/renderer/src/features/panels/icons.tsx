// Glyphs of the panel header buttons (approved icon set "B": 18px, stroke 1.5, square caps,
// currentColor — var(--dm), var(--tx) on hover).

const Glyph = ({ d }: { d: string }) => (
  <svg viewBox="0 0 18 18" width={18} height={18} style={{ display: 'block' }} aria-hidden>
    <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="square" />
  </svg>
);

/** A box with an arrow leaving it: pop the panel out of its column. */
export const PopOutIcon = () => <Glyph d="M8 3.75 H3.75 V14.25 H14.25 V10 M8.75 9.25 L14.75 3.25 M10.25 3.25 H14.75 V7.75" />;

/** The arrow coming back into the box: dock the panel back in its column. */
export const DockIcon = () => <Glyph d="M8 3.75 H3.75 V14.25 H14.25 V10 M14.75 3.25 L8.75 9.25 M8.75 4.75 V9.25 H13.25" />;

/** ▾ collapse to the bar / ▴ expand. */
export const ChevronIcon = ({ up }: { up: boolean }) => <Glyph d={up ? 'M5 11 L9 7 L13 11' : 'M5 7 L9 11 L13 7'} />;
