// Account-level widgets (design v6): portfolio greeks and concentration.

import { useMemo } from 'react';
import { DASH, f0, f2, sg, signColor } from '@shared/format';
import type { Quote } from '@shared/types';
import { useCommon } from '../../../i18n/common';
import { useStore } from '../../../state/store';
import type { PositionRow } from '../calc';
import { usePortfolioMessages } from '../messages';
import { useDashboardMessages } from './messages';
import { concentration, portfolioGreeks } from './model';
import { BigFigure, EmptyLine, List, Note, WidgetCard, pct1 } from './WidgetCard';

const ROW_RULE = 'inset 0 -1px 0 var(--ln2)';

// ---------------------------------------------------------------------------
// Portfolio greeks

export function GreeksWidget({ rows, quotes, known }: { rows: readonly PositionRow[]; quotes: Readonly<Record<string, Quote>>; known: boolean }) {
  const m = useDashboardMessages();
  const g = useMemo(() => portfolioGreeks(rows, quotes), [rows, quotes]);
  // Before the account is known there is nothing to add up (not even zero).
  const v = (n: number | undefined, format: (x: number) => string) => (known ? sg(n, format) : DASH);
  const cells = [
    { label: 'Delta', value: v(g.delta, f0), sub: `${m.dollarDelta} ${v(g.dollarDelta, f0)}`, color: 'var(--tx)' },
    { label: 'Gamma', value: v(g.gamma, (x) => f2(x, 1)), sub: m.gammaSub, color: 'var(--tx)' },
    { label: 'Theta', value: v(g.theta, f0), sub: m.thetaSub, color: known ? signColor(g.theta) : 'var(--tx)' },
    { label: 'Vega', value: v(g.vega, f0), sub: m.vegaSub, color: 'var(--tx)' },
  ];

  return (
    <WidgetCard title={m.greeksTitle} sub={m.greeksSub}>
      <div
        title={g.pending ? m.greeksPending(g.pending) : undefined}
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--ln2)', fontVariantNumeric: 'tabular-nums' }}
      >
        {/* 2×2 cells split by 1px rules: the left column keeps the card's edge, and each column stays 20px off the middle rule. */}
        {cells.map((c, i) => (
          <div
            key={c.label}
            style={{
              background: 'var(--p)',
              padding: i % 2 ? '12px 0 14px 20px' : '12px 20px 14px 0',
              display: 'flex',
              flexDirection: 'column',
              gap: 7,
              minWidth: 0,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--mu)' }}>{c.label}</div>
            <div className="selectable" style={{ font: '500 20px/1 var(--num)', color: c.color, whiteSpace: 'nowrap' }}>
              {c.value}
            </div>
            <div style={{ fontSize: 11, color: 'var(--dm)', lineHeight: 1.4 }}>{c.sub}</div>
          </div>
        ))}
      </div>
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Concentration

export function ConcentrationWidget({ rows, netLiq }: { rows: readonly PositionRow[]; netLiq: number | undefined }) {
  const m = useDashboardMessages();
  const pm = usePortfolioMessages();
  const common = useCommon();
  const connected = useStore((s) => s.connection.status === 'connected');
  const openSymbol = useStore((s) => s.openSymbol);
  const c = useMemo(() => concentration(rows, netLiq), [rows, netLiq]);
  const items = c?.items ?? [];

  return (
    <WidgetCard title={m.concTitle} sub={m.concSub}>
      <BigFigure value={c && items.length ? pct1(c.top3) : DASH} label={m.top3Label} />
      <List>
        {items.map((i) => (
          <div
            key={i.key}
            onClick={() => openSymbol(i.underlying)}
            className="hover-p2"
            style={{
              display: 'grid',
              gridTemplateColumns: '56px minmax(0,1fr) 52px',
              alignItems: 'center',
              gap: 12,
              height: 32,
              cursor: 'pointer',
              boxShadow: ROW_RULE,
            }}
          >
            <div className="ellipsis" style={{ fontSize: 13 }}>
              {i.underlying.symbol}
            </div>
            <div style={{ height: 6, background: 'var(--p2)' }}>
              <div style={{ height: '100%', width: `${c!.max > 0 ? (i.pct / c!.max) * 100 : 0}%`, background: i.flagged ? 'var(--ac)' : 'var(--mu)' }} />
            </div>
            <div style={{ textAlign: 'right', font: '13px/1 var(--num)', color: i.flagged ? 'var(--ac)' : 'var(--tx)', whiteSpace: 'nowrap' }}>
              {pct1(i.pct)}
            </div>
          </div>
        ))}
        {!items.length && <EmptyLine>{!connected ? common.notConnected : rows.length ? pm.noAllocation : pm.noPositions}</EmptyLine>}
      </List>
      <Note>{m.concNote}</Note>
    </WidgetCard>
  );
}
