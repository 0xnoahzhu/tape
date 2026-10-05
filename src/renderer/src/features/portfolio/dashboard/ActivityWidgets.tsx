// Activity and market widgets (design v6): today's trades, earnings & dividends and the
// benchmark comparison.

import { useMemo } from 'react';
import { contractLabel } from '@shared/contract';
import { DASH, f0, f2, pct, px, signColor } from '@shared/format';
import { useClock } from '../../../i18n';
import { useCommon } from '../../../i18n/common';
import { useStore } from '../../../state/store';
import { timeCell } from '../../orders/model';
import { showOrderTrades } from '../../orders/OrdersPage';
import { useOrdersMessages } from '../../orders/messages';
import type { PositionRow } from '../calc';
import { spanLabel } from '../EquityCard';
import { usePortfolioMessages } from '../messages';
import { useBenchmark, useEarnings, useHoldingDividends, useHoldingUnderlyings } from './data';
import { useDashboardMessages } from './messages';
import { recentFills, upcomingEvents, type CorporateEvent } from './model';
import { EmptyLine, List, Note, WidgetCard } from './WidgetCard';

const ROW_RULE = 'inset 0 -1px 0 var(--ln2)';

// ---------------------------------------------------------------------------
// Today's trades

export function FillsWidget() {
  const m = useDashboardMessages();
  const om = useOrdersMessages();
  const common = useCommon();
  const clock = useClock();
  const connected = useStore((s) => s.connection.status === 'connected');
  const executions = useStore((s) => s.executions);
  const { count, items } = useMemo(() => recentFills(executions), [executions]);

  return (
    <WidgetCard
      title={m.fillsTitle}
      sub={m.fillCount(count)}
      aside={
        <div onClick={showOrderTrades} className="hover-tx" style={{ fontSize: 12, color: 'var(--mu)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          {m.all}
        </div>
      }
    >
      {/* One grid for all rows (subgrid), so the time column fits the widest time of either clock format. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(62px,max-content) 36px minmax(0,1fr) auto', columnGap: 10, fontVariantNumeric: 'tabular-nums' }}>
        {items.map((e) => (
          <div
            key={e.execId}
            title={[e.exchange, e.execId].filter(Boolean).join(' · ')}
            style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'subgrid', alignItems: 'center', height: 34, fontSize: 13, boxShadow: ROW_RULE }}
          >
            <div style={{ font: '12px/1 var(--num)', color: 'var(--dm)', whiteSpace: 'nowrap' }}>{timeCell(e.time, clock)}</div>
            <div style={{ fontSize: 12, color: 'var(--mu)', whiteSpace: 'nowrap' }}>{e.side === 'BUY' ? m.buy : m.sell}</div>
            <div className="ellipsis selectable">{contractLabel(e.contract)}</div>
            <div className="selectable" style={{ fontFamily: 'var(--num)', whiteSpace: 'nowrap' }}>
              {f0(e.shares)} @ {px(e.price)}
            </div>
          </div>
        ))}
        {!items.length && <EmptyLine style={{ gridColumn: '1 / -1' }}>{connected ? om.noTrades : common.notConnected}</EmptyLine>}
      </div>
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Earnings & dividends

/** "10/30" from YYYYMMDD. */
const monthDay = (yyyymmdd: string) => `${Number(yyyymmdd.slice(4, 6))}/${Number(yyyymmdd.slice(6, 8))}`;

export function EventsWidget({ rows }: { rows: readonly PositionRow[] }) {
  const m = useDashboardMessages();
  const common = useCommon();
  const connected = useStore((s) => s.connection.status === 'connected');
  const openSymbol = useStore((s) => s.openSymbol);
  const underlyings = useHoldingUnderlyings(rows);
  const dividends = useHoldingDividends(underlyings);
  const earnings = useEarnings(underlyings);
  const events = useMemo(() => upcomingEvents(underlyings, dividends, earnings, new Date()), [underlyings, dividends, earnings]);

  const detail = (e: CorporateEvent) => {
    if (e.kind === 'earnings') return e.time ? `${monthDay(e.date)} · ${m.eventTime[e.time]}` : monthDay(e.date);
    return e.amount != null ? `${monthDay(e.date)} · $${f2(e.amount)}` : monthDay(e.date);
  };

  return (
    <WidgetCard title={m.eventsTitle} sub={m.eventsSub}>
      <List>
        {events.map((e) => (
          <div
            key={`${e.key}|${e.kind}|${e.date}`}
            onClick={() => openSymbol(e.underlying)}
            className="hover-p2"
            style={{ display: 'flex', alignItems: 'center', gap: 12, height: 44, cursor: 'pointer', boxShadow: ROW_RULE }}
          >
            <div style={{ width: 44, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ font: '600 15px/1 var(--num)', color: e.soon ? 'var(--ac)' : 'var(--tx)' }}>{e.days}</div>
              <div style={{ fontSize: 10, color: 'var(--dm)' }}>{m.days}</div>
            </div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div className="ellipsis" style={{ fontSize: 13 }}>
                {e.symbol} · {e.kind === 'earnings' ? m.earnings : m.exDividend}
              </div>
              <div className="ellipsis" style={{ fontSize: 11, color: 'var(--dm)' }}>
                {detail(e)}
              </div>
            </div>
          </div>
        ))}
        {!events.length && <EmptyLine>{connected || rows.length ? m.noEvents : common.notConnected}</EmptyLine>}
      </List>
      <Note>{m.eventsNote}</Note>
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// vs. benchmark

export function BenchWidget() {
  const m = useDashboardMessages();
  const pm = usePortfolioMessages();
  const { range, points, covered, rows, vsSpy } = useBenchmark();
  const span = spanLabel(pm, range, covered, points[0]);

  return (
    <WidgetCard title={m.benchTitle} sub={m.benchSub(span)}>
      <List gap={12}>
        {rows.map((r) => {
          const own = r.key === 'portfolio';
          const known = r.pct != null && Number.isFinite(r.pct);
          const bar = known && r.pct! < 0 ? 'var(--dn)' : own ? 'var(--ac)' : 'var(--mu)';
          return (
            <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '56px minmax(0,1fr) 64px', alignItems: 'center', gap: 12 }}>
              <div className="ellipsis" style={{ fontSize: 13, color: own ? 'var(--tx)' : 'var(--mu)' }}>
                {own ? m.portfolio : r.key}
              </div>
              <div style={{ height: 8, background: 'var(--p2)' }}>
                <div style={{ height: '100%', width: `${(r.frac * 100).toFixed(1)}%`, background: bar, opacity: own ? 1 : 0.55 }} />
              </div>
              <div
                className="selectable"
                style={{ textAlign: 'right', font: '13px/1 var(--num)', color: own ? signColor(r.pct) : 'var(--mu)', whiteSpace: 'nowrap' }}
              >
                {known ? pct(r.pct) : DASH}
              </div>
            </div>
          );
        })}
      </List>
      {vsSpy != null && (
        <div style={{ fontSize: 13, color: signColor(vsSpy) }}>
          {vsSpy >= 0 ? m.aheadOf('SPY', f2(Math.abs(vsSpy), 1)) : m.behind('SPY', f2(Math.abs(vsSpy), 1))}
        </div>
      )}
    </WidgetCard>
  );
}
