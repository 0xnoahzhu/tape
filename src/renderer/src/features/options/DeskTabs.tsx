// Desk tab bar: Chain / Volatility and the expiration chips.

import { useLayoutEffect, useRef, useState } from 'react';
import { shortExpiry, daysToExpiry } from '@shared/contract';
import { useLang } from '../../i18n';
import { TabItems } from '../../ui/primitives';
import { expiryKind, groupByMonth, visibleExpiries, type ChainExpiry, type ExpiryKind } from './chain';
import { DESK_TABS, useDesk } from './deskStore';
import { useM } from './messages';

const kindColor = (k: ExpiryKind) => (k === 'W' ? 'var(--dm)' : k === 'L' ? 'var(--ac)' : 'var(--mu)');
/** Design: chips for the first 6 expirations plus the selected one. */
const FIRST_CHIPS = 6;
const CHIP_GAP = 4;

export function DeskTabs({ expiries, selected }: { expiries: ChainExpiry[]; selected?: string }) {
  const m = useM();
  const tab = useDesk((s) => s.tab);
  const patch = useDesk((s) => s.patch);
  return (
    <div style={{ height: 46, display: 'flex', alignItems: 'stretch', gap: 26, padding: '0 24px', background: 'var(--p)', boxShadow: 'inset 0 -1px 0 var(--ln2)', flexShrink: 0 }}>
      <TabItems
        tabs={DESK_TABS.map((k) => ({ key: k, label: m.tabs[k] }))}
        value={tab}
        onChange={(k) => patch({ tab: k })}
      />
      {expiries.length > 0 && <ExpiryPicker expiries={expiries} selected={selected} />}
    </div>
  );
}

function ExpiryPicker({ expiries, selected }: { expiries: ChainExpiry[]; selected?: string }) {
  const m = useM();
  const lang = useLang();
  const open = useDesk((s) => s.expOpen);
  const patch = useDesk((s) => s.patch);
  const now = new Date();
  const pick = (e: string) => patch({ expiry: e, expOpen: false });

  // As many chips as fit next to the tabs (fewer in a narrow window); "All" always stays visible.
  // Every candidate chip is rendered so it can be measured; the ones that do not fit are hidden.
  const candidates = visibleExpiries(expiries.map((e) => e.expiry), selected, FIRST_CHIPS);
  const strip = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(candidates.length);
  const shown = new Set(visibleExpiries(candidates, selected, FIRST_CHIPS, fit));
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => {
      const widths = new Map([...el.children].map((c) => [(c as HTMLElement).dataset.exp, (c as HTMLElement).offsetWidth]));
      const width = (chips: string[]) => chips.reduce((a, e) => a + (widths.get(e) ?? 0) + CHIP_GAP, -CHIP_GAP);
      let n = candidates.length;
      while (n > 0 && width(visibleExpiries(candidates, selected, FIRST_CHIPS, n)) > el.clientWidth) n--;
      setFit(n);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // Candidates and their labels (language) determine the widths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.join(), lang]);
  const classes = new Set(expiries.map((e) => e.tradingClass));
  const showClass = classes.size > 1;
  const rows = expiries.map((e) => ({ ...e, dte: daysToExpiry(e.expiry, now), kind: expiryKind(e.expiry, now) }));

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: CHIP_GAP }}>
      <div ref={strip} style={{ flex: '1 1 0', minWidth: 0, position: 'relative', display: 'flex', justifyContent: 'flex-end', gap: CHIP_GAP, overflow: 'hidden' }}>
        {candidates.map((e) => (
          <ExpiryChip key={e} expiry={e} on={e === selected} hidden={!shown.has(e)} now={now} onPick={() => pick(e)} />
        ))}
      </div>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <div
          onClick={() => patch({ expOpen: !open })}
          className="hover-tx"
          style={{
            padding: '6px 9px',
            cursor: 'pointer',
            font: '12px/1 var(--num)',
            whiteSpace: 'nowrap',
            color: open ? 'var(--tx)' : 'var(--mu)',
            boxShadow: `inset 0 0 0 1px ${open ? 'var(--ac)' : 'var(--ln)'}`,
          }}
        >
          {m.allExp(expiries.length)}
        </div>
        {open && (
          <>
            <div onClick={() => patch({ expOpen: false })} style={{ position: 'fixed', inset: 0, zIndex: 7 }} />
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                right: 0,
                zIndex: 8,
                width: 460,
                maxHeight: 440,
                overflow: 'auto',
                background: 'var(--p)',
                boxShadow: '0 0 0 1px var(--ln),0 16px 48px rgba(0,0,0,.22)',
                padding: '6px 0 10px',
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '72px 64px 60px 1fr', gap: 10, padding: '8px 16px', fontSize: 11, color: 'var(--dm)', boxShadow: 'inset 0 -1px 0 var(--ln2)' }}>
                <div>{m.expDate}</div>
                <div>{m.expDte}</div>
                <div>{m.expKind}</div>
                <div>{showClass ? m.expClass : ''}</div>
              </div>
              {groupByMonth(rows, lang).map((g) => (
                <div key={g.name}>
                  <div style={{ padding: '12px 16px 4px', fontSize: 11, fontWeight: 600, color: 'var(--mu)' }}>{g.name}</div>
                  {g.rows.map((e) => {
                    const on = e.expiry === selected;
                    return (
                      <div
                        key={e.expiry}
                        onClick={() => pick(e.expiry)}
                        className="hover-p2"
                        style={{
                          height: 34,
                          display: 'grid',
                          gridTemplateColumns: '72px 64px 60px 1fr',
                          alignItems: 'center',
                          gap: 10,
                          padding: '0 16px',
                          cursor: 'pointer',
                          background: on ? 'var(--sel)' : 'transparent',
                        }}
                      >
                        <div style={{ font: '600 12px/1 var(--num)', color: on ? 'var(--tx)' : 'var(--mu)' }}>{shortExpiry(e.expiry)}</div>
                        <div style={{ font: '12px/1 var(--num)', color: 'var(--dm)' }}>{m.nDays(e.dte)}</div>
                        <div style={{ font: '600 10px/1 var(--mono)', color: kindColor(e.kind) }}>{m.kinds[e.kind]}</div>
                        <div style={{ font: '11px/1 var(--sans)', color: 'var(--ac)' }}>{showClass ? e.tradingClass : ''}</div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** A hidden chip is out of the flow and invisible but keeps its width for measuring. */
function ExpiryChip({ expiry, on, hidden, now, onPick }: { expiry: string; on: boolean; hidden: boolean; now: Date; onPick: () => void }) {
  const m = useM();
  const kind = expiryKind(expiry, now);
  return (
    <div
      data-exp={expiry}
      onClick={onPick}
      style={{
        ...(hidden ? { position: 'absolute', visibility: 'hidden' } : {}),
        padding: '6px 9px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'baseline',
        gap: 5,
        flexShrink: 0,
        whiteSpace: 'nowrap',
        boxShadow: `inset 0 0 0 1px ${on ? 'var(--ac)' : 'var(--ln)'}`,
        color: on ? 'var(--tx)' : 'var(--mu)',
      }}
    >
      <div style={{ font: '12px/1 var(--num)' }}>{shortExpiry(expiry)}</div>
      <div style={{ font: '10px/1 var(--num)', color: 'var(--dm)' }}>{m.nDays(daysToExpiry(expiry, now))}</div>
      <div style={{ font: '600 10px/1 var(--mono)', color: kindColor(kind) }} title={m.kinds[kind]}>
        {kind}
      </div>
    </div>
  );
}
