// A search result's name followed by its listing tag. When space runs out the name is shortened
// first; a depositary receipt suffix ("-CDR", "-SP ADR") and the tag ("NASDAQ", "MEXI · MXN")
// always stay visible, since they are what tells listings of one company apart. Hovering a
// shortened name shows it in full.

import type { CSSProperties, RefObject } from 'react';
import { useOverflowTip } from '../../ui/OverflowTip';
import { splitReceipt } from './listing';

export const listingTagStyle: CSSProperties = { font: '10.5px/1 var(--mono)', color: 'var(--dm)', whiteSpace: 'nowrap', flexShrink: 0 };

/**
 * `tagAtEnd` puts the tag at the right edge (a column, as in the watchlist) instead of after the
 * name. `row` is given when columns follow the name (prices): the full name's tip then reaches the
 * row's right edge, covering those of the row below whole instead of ending inside a number.
 */
export function ListingName({ name, tag, tagAtEnd, row, style }: { name: string; tag: string; tagAtEnd?: boolean; row?: RefObject<HTMLElement | null>; style?: CSSProperties }) {
  const { base, suffix } = splitReceipt(name);
  const { textRef, hoverProps, tip } = useOverflowTip(
    <>
      {name}
      {tag && (
        <span style={{ color: 'var(--dm)' }}>
          {' · '}
          <span style={{ font: listingTagStyle.font }}>{tag}</span>
        </span>
      )}
    </>,
    row,
  );
  return (
    // Stretched to the row's height, so the whole name column is the hover area.
    <div {...hoverProps} style={{ display: 'flex', alignItems: 'center', alignSelf: 'stretch', gap: 8, minWidth: 0, ...style }}>
      <div style={{ display: 'flex', flex: tagAtEnd ? 1 : undefined, minWidth: 0, fontSize: 12, color: 'var(--mu)' }}>
        <div ref={textRef} className="ellipsis" style={{ minWidth: 0 }}>
          {base}
        </div>
        {suffix && <div style={{ flexShrink: 0, whiteSpace: 'pre' }}>{suffix}</div>}
      </div>
      {tag && <div style={listingTagStyle}>{tag}</div>}
      {tip}
    </div>
  );
}
