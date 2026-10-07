// The order ticket's parts, laid out by the docked ticket (OrderTicket, design 3a) and by the
// floating ticket (features/panels/TicketFloat). Every part reads the shared controller
// (useTicket) and a size scale: DOCKED_SCALE is the design's 340px column exactly; the floating panel's
// scales grow type and controls with its width.

import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ContractRef } from '@shared/types';
import { f0 } from '@shared/format';
import { NEW_YORK, TIME_IN_FORCES, zonedParts } from '@shared/orderTiming';
import { MAIN_ORDER_TYPES, ORDER_TYPE_GROUPS } from '@shared/orderRules';
import type { useCommon } from '../../i18n/common';
import { Chip } from '../../ui/primitives';
import { AdvancedPanel } from './AdvancedPanel';
import { Dropdown, MenuChoice, MenuHeading, unavailableStyle } from './controls';
import { DateTimeField, FieldBox, NumberField, TextField } from './fields';
import type { TicketMessages } from './messages';
import { isTrailing, money, priceInput, priceText, stepQty } from './ticketModel';
import { toLocalInput } from './timing';
import type { TicketCtl } from './useTicket';
import { WhatIfRows } from './WhatIf';

export const label12: CSSProperties = { fontSize: 12, color: 'var(--dm)' };
export const column6: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const priceFont: CSSProperties = { font: '500 15px/1 var(--num)', fontVariantNumeric: 'tabular-nums' };

/** Sizes of the ticket's controls. */
export interface TicketScale {
  /** Field labels. */
  label: CSSProperties;
  /** Bid / ask prices and the boxes' padding. */
  quote: number;
  quotePad: string;
  /** Buy / sell switch, order type chips. */
  side: number;
  type: number;
  typeFont: number;
  /** Quantity and price boxes (undefined: the design's 40px). */
  field?: number;
  /** Numbers typed in the boxes. */
  priceSize: number;
  /** Room for the quantity's digits (see qtyFontSize). */
  qtyRoom: number;
  totals: number;
  submit: number;
  submitFont: number;
}

export const DOCKED_SCALE: TicketScale = {
  label: label12,
  quote: 17,
  quotePad: '10px 12px',
  side: 36,
  type: 32,
  typeFont: 12,
  priceSize: 15,
  qtyRoom: 118,
  totals: 13,
  submit: 46,
  submitFont: 15,
};

const numFont = (S: TicketScale): CSSProperties => (S.priceSize === 15 ? priceFont : { ...priceFont, font: `500 ${S.priceSize}px/1 var(--num)` });
const fieldStyle = (S: TicketScale): CSSProperties | undefined => (S.field ? { height: S.field } : undefined);

/** Tradable instruments only: the rest of the ticket is dimmed and inert. */
export const lockStyle = (T: TicketCtl): CSSProperties | undefined => (T.tradable ? undefined : { opacity: 0.4, pointerEvents: 'none' });

export function kindLabel(c: ContractRef, common: ReturnType<typeof useCommon>, m: TicketMessages): string {
  switch (c.secType) {
    case 'STK':
      return common.stock;
    case 'OPT':
    case 'FOP':
      return common.option;
    case 'IND':
      return common.index;
    case 'FUT':
      return m.future;
    default:
      return c.secType;
  }
}

const sizeText = (n: number | undefined) => (n != null && n >= 0 ? f0(n) : '—');

/**
 * The qty input between the ± buttons is 72px wide when the ticket shows its scrollbar, and mono
 * digits are 0.6em wide: 15px fits "100,000", longer quantities shrink so no digit is clipped.
 */
const qtyFontSize = (text: string, S: TicketScale) => Math.max(10, Math.min(S.priceSize, Math.floor(S.qtyRoom / text.length)));

/** A boxed price row: label on the left, the number on the right (stop-limit limit, offsets, caps). */
function PriceRow({
  label,
  display,
  edit,
  placeholder,
  onInput,
  onCommit,
  style,
}: {
  label: string;
  display: string;
  edit: string;
  placeholder?: string;
  onInput: (n: number | null) => void;
  onCommit?: (n: number | null) => void;
  style?: CSSProperties;
}) {
  const [focus, setFocus] = useState(false);
  return (
    <FieldBox focused={focus} style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '0 12px', flexShrink: 0, ...style }}>
      <div style={{ ...label12, flexShrink: 0 }}>{label}</div>
      <NumberField display={display} edit={edit} placeholder={placeholder ?? '—'} onInput={onInput} onCommit={onCommit} onFocusChange={setFocus} style={{ textAlign: 'right', ...priceFont }} />
    </FieldBox>
  );
}

/** A two-way segmented switch (trail by % or $, offset by % or $). */
function PctAmt({ value, onChange, lock }: { value: 'pct' | 'amt'; onChange: (v: 'pct' | 'amt') => void; /** Why the mode cannot change. */ lock?: string | null }) {
  return (
    <div style={{ display: 'flex', background: 'var(--p2)', padding: 2 }} title={lock ?? undefined}>
      {(['pct', 'amt'] as const).map((k) => (
        <div
          key={k}
          onClick={lock || value === k ? undefined : () => onChange(k)}
          aria-disabled={!!lock && value !== k}
          style={{
            opacity: lock && value !== k ? 0.4 : 1,
            flex: 1,
            height: 30,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            cursor: lock && value !== k ? 'not-allowed' : 'pointer',
            background: value === k ? 'var(--p)' : 'transparent',
            color: value === k ? 'var(--tx)' : 'var(--dm)',
          }}
        >
          {k === 'pct' ? '%' : '$'}
        </div>
      ))}
    </div>
  );
}

export function NotTradableNote({ T }: { T: TicketCtl }) {
  if (T.tradable) return null;
  return <div style={{ padding: '10px 12px', background: 'var(--p2)', fontSize: 12, lineHeight: 1.5, color: 'var(--mu)' }}>{T.c.indexNotTradable(T.symbol.symbol)}</div>;
}

/**
 * Bid × size / ask × size. Docked, a click picks the side (sell at the bid, buy at the ask);
 * `onPick` replaces that (the floating ticket fills the limit price with the clicked quote).
 */
export function QuoteBoxes({ T, S, onPick, title }: { T: TicketCtl; S: TicketScale; onPick?: (which: 'bid' | 'ask') => void; title?: (which: 'bid' | 'ask') => string | undefined }) {
  const { m, q, market, minTick, buy, sideLock } = T;
  const via = q?.source?.kind === 'primary' ? m.quoteVia(q.source.exchange, q.marketDataType) : undefined;
  const tip = (which: 'bid' | 'ask') => (title ? title(which) : sideLock && (which === 'bid') === buy ? sideLock : via);
  const pick = (which: 'bid' | 'ask') => (onPick ? () => onPick(which) : sideLock ? undefined : () => T.setSide(which === 'bid' ? 'SELL' : 'BUY'));
  const box = (which: 'bid' | 'ask'): CSSProperties => ({
    padding: S.quotePad,
    background: 'var(--p2)',
    cursor: onPick || !sideLock ? 'pointer' : 'default',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    ...(which === 'ask' ? { alignItems: 'flex-end' } : null),
    boxShadow: which === 'ask' ? (buy ? 'inset 0 0 0 1px var(--up)' : 'none') : buy ? 'none' : 'inset 0 0 0 1px var(--dn)',
  });
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontVariantNumeric: 'tabular-nums', ...lockStyle(T) }}>
      <div onClick={pick('bid')} title={tip('bid')} style={box('bid')}>
        <div style={S.label}>
          {m.bid} × {sizeText(q?.bidSize)}
        </div>
        <div className="selectable" style={{ font: `600 ${S.quote}px/1 var(--num)`, color: 'var(--dn)' }}>
          {priceText(market.bid, minTick)}
        </div>
      </div>
      <div onClick={pick('ask')} title={tip('ask')} style={box('ask')}>
        <div style={S.label}>
          {m.ask} × {sizeText(q?.askSize)}
        </div>
        <div className="selectable" style={{ font: `600 ${S.quote}px/1 var(--num)`, color: 'var(--up)' }}>
          {priceText(market.ask, minTick)}
        </div>
      </div>
    </div>
  );
}

/**
 * "No market data (354) · …" under the quote boxes; otherwise, for a quote served by the stock's
 * primary exchange, "Live · NASDAQ: NASDAQ's own bid/ask, not the consolidated quote (NBBO)".
 */
export function MarketIssue({ T }: { T: TicketCtl }) {
  const { showIssue, issue, m, q } = T;
  if (!showIssue || !issue) {
    if (q?.source?.kind !== 'primary') return null;
    const text = m.quoteVia(q.source.exchange, q.marketDataType);
    return (
      <div data-ticket="quote-via" className="ellipsis" title={text} style={{ fontSize: 11, color: 'var(--dm)', marginTop: -8 }}>
        {text}
      </div>
    );
  }
  return (
    <div className="ellipsis" title={issue.message} style={{ fontSize: 11, color: 'var(--dm)', marginTop: -8 }}>
      {m.noMarketData(issue.code)} · {issue.message}
    </div>
  );
}

export function SideSwitch({ T, S }: { T: TicketCtl; S: TicketScale }) {
  const { t, sideLock, c } = T;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', background: 'var(--p2)', padding: 3, ...lockStyle(T) }}>
      {(['BUY', 'SELL'] as const).map((side) => {
        const on = t.side === side;
        const why = on ? null : sideLock;
        return (
          <div
            key={side}
            onClick={why ? undefined : () => T.setSide(side)}
            title={why ?? undefined}
            style={{
              height: S.side,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 600,
              ...(S.side > 36 ? { fontSize: Math.round(S.side / 2.8) } : null),
              cursor: why ? 'not-allowed' : 'pointer',
              background: on ? (side === 'BUY' ? 'var(--up)' : 'var(--dn)') : 'transparent',
              color: on ? 'var(--btnTx)' : 'var(--mu)',
              ...(why ? { opacity: 0.5 } : undefined),
            }}
          >
            {side === 'BUY' ? c.buy : c.sell}
          </div>
        );
      })}
    </div>
  );
}

/** The main order types as chips, "More ▾" with the rest (its menu) and the chosen one's hint. */
export function OrderTypeRow({ T, S }: { T: TicketCtl; S: TicketScale }) {
  const { m, t, type, isMore, typeWhy, openWhy } = T;
  const moreRef = useRef<HTMLDivElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const setType: TicketCtl['setType'] = (k, extra) => {
    setMoreOpen(false);
    T.setType(k, extra);
  };
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...lockStyle(T) }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {MAIN_ORDER_TYPES.map((k) => {
            const why = k === type ? null : typeWhy(k);
            return (
              <div
                key={k}
                onClick={why ? undefined : () => setType(k)}
                title={why ? `${m.typeHints[k]}\n${m.unavailable(why)}` : m.typeHints[k]}
                style={{
                  flex: '1 1 auto',
                  height: S.type,
                  padding: '0 4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: S.typeFont,
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                  boxShadow: `inset 0 0 0 1px ${type === k ? 'var(--ac)' : 'var(--ln)'}`,
                  color: type === k ? 'var(--tx)' : 'var(--mu)',
                  ...(why ? unavailableStyle : undefined),
                }}
              >
                {m.orderTypes[k]}
              </div>
            );
          })}
          <div
            ref={moreRef}
            role="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
            title={isMore ? `${m.orderTypes[type]} (${type})` : undefined}
            style={{
              flex: '1 1 auto',
              height: S.type,
              padding: '0 6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              fontSize: S.typeFont,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              boxShadow: `inset 0 0 0 1px ${isMore || moreOpen ? 'var(--ac)' : 'var(--ln)'}`,
              color: isMore ? 'var(--tx)' : 'var(--mu)',
            }}
          >
            {m.more}
            <span style={{ fontSize: 12, lineHeight: 1, color: 'var(--dm)' }}>▾</span>
          </div>
        </div>
        {isMore && (
          <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--dm)' }}>
            <span style={{ color: 'var(--mu)' }}>{m.orderTypes[type]}</span> · {m.typeHints[type]}
          </div>
        )}
      </div>
      {moreOpen && (
        <Dropdown anchor={moreRef.current} width={292} onClose={() => setMoreOpen(false)}>
          {ORDER_TYPE_GROUPS.map((g) => (
            <div key={g.id}>
              <MenuHeading>{m.typeGroups[g.id]}</MenuHeading>
              {g.types.map((k) => (
                <MenuChoice
                  key={k}
                  active={type === k}
                  why={k === type ? null : typeWhy(k)}
                  hint={m.typeHints[k]}
                  onPick={() => setType(k)}
                  label={
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                      <span>{m.orderTypes[k]}</span>
                      <span style={{ font: '11px/1.4 var(--mono)', color: 'var(--dm)' }}>{k}</span>
                    </div>
                  }
                />
              ))}
              {g.id === 'auction' &&
                (['MKT', 'LMT'] as const).map((k) => (
                  <MenuChoice
                    key={`open-${k}`}
                    active={type === k && t.tif === 'OPG'}
                    why={type === k && t.tif === 'OPG' ? null : openWhy(k)}
                    hint={m.openHint}
                    onPick={() => setType(k, { tif: 'OPG' })}
                    label={
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                        <span>{k === 'MKT' ? m.moo : m.loo}</span>
                        <span style={{ font: '11px/1.4 var(--mono)', color: 'var(--dm)' }}>{k} · OPG</span>
                      </div>
                    }
                  />
                ))}
            </div>
          ))}
        </Dropdown>
      )}
    </>
  );
}

/** The quantity box (−, the number, +), or the forex amount when the order is sized by cash. */
export function QtyField({ T, S }: { T: TicketCtl; S: TicketScale }) {
  const { t, patch, cashSized, m, c } = T;
  const [focus, setFocus] = useState(false);
  const qtyText = f0(t.qty);
  const pxFont = numFont(S);
  return (
    <div style={column6}>
      <div style={S.label}>{cashSized ? m.amount : c.qty}</div>
      {cashSized ? (
        <FieldBox focused={focus} style={fieldStyle(S)}>
          <TextField value={t.cashQty} onChange={(v) => patch({ cashQty: v.replace(/[^\d.,]/g, '') })} style={{ height: 38, boxShadow: 'none', ...pxFont, textAlign: 'center' }} />
        </FieldBox>
      ) : (
        <FieldBox focused={focus} style={fieldStyle(S)}>
          <Stepper onClick={() => patch({ qty: stepQty(t.qty, -1) })}>−</Stepper>
          <NumberField
            integer
            display={qtyText}
            edit={Number.isFinite(t.qty) ? String(t.qty) : ''}
            title={qtyText}
            onInput={(n) => n != null && patch({ qty: Math.round(n) })}
            onFocusChange={setFocus}
            style={{ flex: 1, textAlign: 'center', ...pxFont, font: `500 ${qtyFontSize(qtyText, S)}px/1 var(--num)`, textOverflow: 'ellipsis' }}
          />
          <Stepper onClick={() => patch({ qty: stepQty(t.qty, 1) })}>+</Stepper>
        </FieldBox>
      )}
    </div>
  );
}

function Stepper({ onClick, children, title }: { onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <div
      onClick={onClick}
      title={title}
      className="hover-tx"
      style={{ width: 32, height: '100%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--mu)' }}
    >
      {children}
    </div>
  );
}

/**
 * The main price box (limit, trigger, offset or a read-only market). `step` adds − / + buttons
 * that move the price by the contract's tick (the floating ticket's layout).
 */
export function PriceField({ T, S, step }: { T: TicketCtl; S: TicketScale; step?: { down: () => void; up: () => void; downTitle?: string; upTitle?: string } }) {
  const { main, mainLabel, t, model, minTick, patch } = T;
  const [focus, setFocus] = useState(false);
  const pxFont = numFont(S);
  const steppers = step && main.key != null;
  const pad = steppers ? '0 4px' : '0 12px';
  return (
    <div style={column6}>
      <div style={S.label}>{mainLabel}</div>
      <FieldBox focused={focus} style={fieldStyle(S)}>
        {steppers && (
          <Stepper onClick={step.down} title={step.downTitle}>
            −
          </Stepper>
        )}
        {main.key == null ? (
          <NumberField readOnly display={main.readOnly ?? ''} edit="" onInput={() => {}} style={{ padding: pad, textAlign: 'right', ...pxFont, color: 'var(--dm)' }} />
        ) : main.key === 'offset' ? (
          <NumberField
            display={t.orderType === 'REL' && t.offsetMode === 'pct' ? String(model.offset) : priceText(model.offset, minTick)}
            edit={String(model.offset)}
            placeholder="0"
            onInput={(n) => patch({ offset: n })}
            onFocusChange={setFocus}
            style={{ padding: pad, textAlign: steppers ? 'center' : 'right', ...pxFont }}
          />
        ) : (
          <NumberField
            display={main.value != null ? priceText(main.value, minTick) : ''}
            edit={priceInput(main.value, minTick)}
            placeholder={main.placeholder ?? '—'}
            onInput={(n) => T.setPrice(main.key as 'limitPrice' | 'stopPrice', n)}
            onCommit={T.commitPrice(main.key)}
            onFocusChange={setFocus}
            style={{ padding: pad, textAlign: steppers ? 'center' : 'right', ...pxFont }}
          />
        )}
        {steppers && (
          <Stepper onClick={step.up} title={step.upTitle}>
            +
          </Stepper>
        )}
      </FieldBox>
    </div>
  );
}

/** Quantity and price side by side (the docked ticket). */
export function QtyPriceRow({ T, S }: { T: TicketCtl; S: TicketScale }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, ...lockStyle(T) }}>
      <QtyField T={T} S={S} />
      <PriceField T={T} S={S} />
    </div>
  );
}

/** The extra price rows of trailing, stop-limit / limit-if-touched, relative and pegged orders. */
export function TypeExtras({ T, S }: { T: TicketCtl; S: TicketScale }) {
  const { type, t, patch, m, model, minTick, capLabel, noCap, modifying } = T;
  const lock = lockStyle(T);
  const lbl = S.label;
  return (
    <>
      {isTrailing(type) && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, ...lock }}>
            <div style={column6}>
              <div style={lbl}>{m.trailBy}</div>
              <PctAmt value={t.trailMode} onChange={(k) => patch({ trailMode: k, stopPrice: null })} />
            </div>
            <div style={column6}>
              <div style={lbl}>{t.trailMode === 'pct' ? m.trailPct : m.trailAmt}</div>
              <TextField
                value={t.trailAmt}
                onChange={(v) => patch({ trailAmt: v.replace(/[^\d.]/g, ''), stopPrice: null })}
                style={{ padding: '0 12px', font: '500 14px/1 var(--num)' }}
              />
            </div>
          </div>
          {(type === 'TRAIL LIMIT' || type === 'TRAIL LIT') && (
            <PriceRow
              label={m.limitOffset}
              display={model.limitOffset != null ? priceText(model.limitOffset, minTick) : ''}
              edit={priceInput(model.limitOffset, minTick)}
              onInput={(n) => patch({ limitOffset: n })}
              onCommit={T.commitPrice('limitOffset')}
              style={lock}
            />
          )}
          <div style={{ fontSize: 11, color: 'var(--dm)', ...lock }}>{(type === 'TRAIL MIT' || type === 'TRAIL LIT' ? m.trailTouchedHint : m.trailHint)(priceText(model.stop, minTick))}</div>
        </>
      )}

      {(type === 'STP LMT' || type === 'LIT') && (
        <PriceRow
          label={m.limit}
          display={model.limit != null ? priceText(model.limit, minTick) : ''}
          edit={priceInput(model.limit, minTick)}
          onInput={(n) => patch({ limitPrice: n })}
          onCommit={T.commitPrice('limitPrice')}
          style={lock}
        />
      )}

      {type === 'REL' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, ...lock }}>
          <div style={column6}>
            <div style={lbl}>{m.offsetBy}</div>
            <PctAmt value={t.offsetMode === 'pct' ? 'pct' : 'amt'} onChange={(k) => patch({ offsetMode: k, offset: null })} lock={modifying != null ? m.locked.offsetMode : null} />
          </div>
          <div style={column6}>
            <div style={lbl}>{capLabel}</div>
            <PriceRow
              label=""
              display={model.limit != null ? priceText(model.limit, minTick) : ''}
              edit={priceInput(model.limit, minTick)}
              placeholder={noCap}
              onInput={(n) => patch({ limitPrice: n })}
              onCommit={T.commitPrice('limitPrice')}
              style={{ height: 34 }}
            />
          </div>
        </div>
      )}
      {type === 'PEG MID' && (
        <PriceRow
          label={capLabel}
          display={model.limit != null ? priceText(model.limit, minTick) : ''}
          edit={priceInput(model.limit, minTick)}
          placeholder={noCap}
          onInput={(n) => patch({ limitPrice: n })}
          onCommit={T.commitPrice('limitPrice')}
          style={lock}
        />
      )}
    </>
  );
}

/**
 * TIF chips, the GTD expiry row when chosen, and the ticket's timing / combination problem.
 * `session`: the session in effect beside the TIF label (a click opens Advanced), docked only.
 */
export function TifRow({ T, S, session = true }: { T: TicketCtl; S: TicketScale; session?: boolean }) {
  const { t, patch, c, m, tifHints, sessionHints, goodTill, now, timingIssue, combo, tifWhy } = T;
  const [gtdFocus, setGtdFocus] = useState(false);
  return (
    <div style={{ ...column6, ...lockStyle(T) }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div style={S.label}>{c.tif}</div>
        {session && T.session !== 'regular' && (
          <div
            onClick={() => patch({ advancedOpen: true })}
            title={sessionHints[T.session]}
            className="ellipsis hover-tx"
            style={{ fontSize: 12, color: 'var(--mu)', cursor: 'pointer' }}
          >
            {c.sessions[T.session]}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {TIME_IN_FORCES.map((k) => {
          const why = tifWhy(k);
          return (
            <Chip
              key={k}
              active={t.tif === k}
              title={why ? `${tifHints[k]}\n${m.unavailable(why)}` : tifHints[k]}
              onClick={why ? undefined : () => patch({ tif: k })}
              style={{ flex: 1, padding: S.typeFont > 12 ? '9px 0' : '6px 0', textAlign: 'center', ...(S.typeFont > 12 ? { fontSize: S.typeFont } : null), ...(why ? unavailableStyle : undefined) }}
            >
              {k}
            </Chip>
          );
        })}
      </div>
      {t.tif === 'GTD' && (
        <FieldBox focused={gtdFocus} style={{ justifyContent: 'space-between', gap: 12, padding: '0 12px' }}>
          <div style={{ ...S.label, flexShrink: 0 }}>{m.goodTill}</div>
          <DateTimeField
            value={goodTill ? toLocalInput(goodTill) : ''}
            min={toLocalInput(zonedParts(now, NEW_YORK))}
            title={tifHints.GTD}
            onChange={(v) => patch({ goodTill: v })}
            onFocusChange={setGtdFocus}
          />
        </FieldBox>
      )}
      {timingIssue && <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--r)' }}>{timingIssue}</div>}
      {combo && (
        <div role="alert" style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--r)' }}>
          {T.ruleText(combo)}
        </div>
      )}
    </div>
  );
}

/** "Advanced" (or what is on in it) with expand / collapse. */
export function AdvancedToggle({ T }: { T: TicketCtl }) {
  const { t, patch, m, advancedItems } = T;
  return (
    <div
      onClick={() => patch({ advancedOpen: !t.advancedOpen })}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer', fontSize: 13, color: 'var(--mu)', padding: '4px 0', ...lockStyle(T) }}
    >
      <div className="ellipsis" title={advancedItems.length ? m.advancedOn(advancedItems) : undefined} style={{ minWidth: 0, color: advancedItems.length ? 'var(--tx)' : undefined }}>
        {advancedItems.length ? m.advancedOn(advancedItems) : m.advanced}
      </div>
      <div style={{ flexShrink: 0 }}>{t.advancedOpen ? m.collapse : m.expand}</div>
    </div>
  );
}

/** The Advanced sections; `session` false leaves the trading session to the caller's layout. */
export function AdvancedBlock({ T, session = true }: { T: TicketCtl; session?: boolean }) {
  return (
    <div style={lockStyle(T)}>
      <AdvancedPanel
        t={T.t}
        model={T.model}
        patch={T.patch}
        contract={T.symbol}
        refContract={T.refContract}
        timing={T.timing}
        choices={T.choices}
        request={T.composed}
        validExchanges={T.info?.validExchanges}
        ocaGroups={T.ocaGroups}
        now={T.now}
        modified={T.modifiedOrder}
        session={session}
      />
    </div>
  );
}

/** Estimated amount and IBKR's what-if (initial margin change, commission). */
export function Totals({ T, S }: { T: TicketCtl; S: TicketScale }) {
  const { c, est, symbol } = T;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: S.totals, color: 'var(--mu)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>{c.estAmount}</div>
        <div className="num selectable" style={{ color: 'var(--tx)' }}>
          {money(est, symbol.currency)}
        </div>
      </div>
      <WhatIfRows T={T} />
    </div>
  );
}

/** The submit button's text: "Buy 100 AAPL", "Modify #1234". */
export function submitText(T: TicketCtl): string {
  const { m, c, t, buy, cashSized, symbol, label, modifying } = T;
  return modifying != null ? m.modify(modifying) : m.submit(buy ? c.buy : c.sell, cashSized ? `${t.cashQty} ${symbol.currency}` : m.units(f0(t.qty), symbol.secType), label);
}

/**
 * The submit button and, while modifying, "Cancel modify" under it. `label` / `busy` replace the
 * text and disable the button (the floating ticket: "Submitting…" until IB answers).
 */
export function SubmitBlock({ T, S, label, busy = false, cancelModify = true }: { T: TicketCtl; S: TicketScale; label?: string; busy?: boolean; cancelModify?: boolean }) {
  const { tradable, buy, modifying, patch, m } = T;
  const enabled = tradable && !busy;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }}>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={enabled ? T.submit : undefined}
        disabled={!enabled}
        aria-busy={busy || undefined}
        style={{
          height: S.submit,
          flexShrink: 0,
          border: 'none',
          padding: '0 12px',
          background: buy ? 'var(--up)' : 'var(--dn)',
          color: 'var(--btnTx)',
          font: `600 ${S.submitFont}px/1 var(--sans)`,
          cursor: tradable ? (busy ? 'wait' : 'pointer') : 'not-allowed',
          opacity: tradable ? (busy ? 0.7 : 1) : 0.4,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label ?? submitText(T)}
      </button>
      {cancelModify && modifying != null && (
        <div onClick={() => patch({ modifyingOrderId: null })} className="hover-tx" style={{ alignSelf: 'center', fontSize: 12, color: 'var(--dm)', cursor: 'pointer' }}>
          {m.cancelModify}
        </div>
      )}
    </div>
  );
}
