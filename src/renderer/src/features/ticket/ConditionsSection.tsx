// The conditions editor of the ticket's Advanced panel: up to five conditions (price, time,
// percent change, volume, margin cushion, execution) joined by and / or, submitting or cancelling
// the order when they are met, optionally also outside regular hours. IB monitors them on its
// servers. A working order keeps its conditions' kinds and mode (IB ignores such changes); their
// values can change.

import { useMemo, useRef, useState } from 'react';
import { contractKey, contractLabel, stock } from '@shared/contract';
import { MAX_CONDITIONS, triggerMethodsFor } from '@shared/orderRules';
import { NEW_YORK, zonedParts } from '@shared/orderTiming';
import type { ContractRef, SecType, TriggerMethod } from '@shared/types';
import { useCommon } from '../../i18n/common';
import type { TicketCondition, TicketConditionKind, TicketState } from '../../state/store';
import { listingTag } from '../search/listing';
import { looksLikeTicker, normalizeTicker, suggestionsFrom } from '../watchlist/model';
import { useSymbolSearch } from '../watchlist/useSymbolSearch';
import { Check, Dropdown, Field, hint11, MenuChoice, Seg, Select, SwitchRow, type Choices } from './controls';
import { DateTimeField, FieldBox, TextField } from './fields';
import { useTicketM } from './messages';
import { CONDITION_KINDS, defaultConditionTime, newCondition } from './ticketConditions';
import type { TicketModel } from './ticketModel';
import { toLocalInput } from './timing';

const EXEC_SEC_TYPES: readonly SecType[] = ['STK', 'OPT', 'FUT', 'FOP', 'CASH'];

/**
 * The instrument a condition watches: shows its symbol; a click turns it into a search (IB's
 * symbol search, stocks and indexes) whose pick replaces it. Empty and left: back to the default.
 */
function WatchedSymbol({ contract, fallback, onPick, disabled }: { contract: ContractRef | null; fallback: ContractRef; onPick: (c: ContractRef | null) => void; disabled?: boolean }) {
  const m = useTicketM();
  const c = useCommon();
  const [query, setQuery] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const search = useSymbolSearch(query ?? '');
  const shown = contract ?? fallback;
  const rows = useMemo(() => {
    if (query == null) return [];
    if (search.status === 'unavailable') return looksLikeTicker(search.query) ? [{ contract: stock(normalizeTicker(search.query)) }] : [];
    return suggestionsFrom(search.matches, search.query, new Set(), 6);
  }, [query, search.status, search.query, search.matches]);
  const pick = (next: ContractRef | null) => {
    setQuery(null);
    onPick(next && contractKey(next) === contractKey(fallback) ? null : next);
  };
  return (
    <>
      <div
        ref={box}
        onClick={disabled || query != null ? undefined : () => setQuery('')}
        title={contractLabel(shown)}
        style={{
          height: 34,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 10px',
          boxShadow: `inset 0 0 0 1px ${query != null ? 'var(--ac)' : 'var(--ln)'}`,
          background: 'var(--p)',
          fontSize: 12,
          minWidth: 0,
          cursor: disabled ? 'default' : 'text',
        }}
      >
        {query == null ? (
          <div className="ellipsis" style={{ font: '600 12px/1 var(--mono)' }}>
            {shown.secType === 'STK' || shown.secType === 'IND' ? shown.symbol : contractLabel(shown)}
          </div>
        ) : (
          <input
            autoFocus
            value={query}
            placeholder={m.symbolPh}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter' && rows[0]) pick(rows[0].contract);
              if (e.key === 'Escape') setQuery(null);
            }}
            onBlur={() => query === '' && setQuery(null)}
            style={{ border: 'none', background: 'transparent', color: 'var(--tx)', width: '100%', minWidth: 0, font: '600 12px/1 var(--mono)', padding: 0 }}
          />
        )}
      </div>
      {query != null && query.trim() !== '' && (
        <Dropdown anchor={box.current} width={220} onClose={() => setQuery(null)}>
          {rows.map((r) => (
            <MenuChoice
              key={contractKey(r.contract)}
              label={
                <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ font: '600 12px/1.4 var(--mono)' }}>{contractLabel(r.contract)}</span>
                  <span className="ellipsis" style={{ fontSize: 11, color: 'var(--dm)' }}>
                    {listingTag(r.contract, c.index)}
                  </span>
                </span>
              }
              hint={'name' in r ? r.name : undefined}
              onPick={() => pick(r.contract)}
            />
          ))}
          {!rows.length && <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--dm)' }}>{search.status === 'loading' ? m.searching : '—'}</div>}
        </Dropdown>
      )}
    </>
  );
}

const ops = [
  { key: '>=' as const, label: '≥' },
  { key: '<=' as const, label: '≤' },
];

export function ConditionsSection({
  t,
  model,
  patch,
  contract,
  refContract,
  modifying,
  choices,
  now,
  summary,
}: {
  t: TicketState;
  model: TicketModel;
  patch: (p: Partial<TicketState>) => void;
  contract: ContractRef;
  refContract: ContractRef;
  modifying: boolean;
  choices: Choices;
  now: number;
  /** The conditions as they read ("AAPL ≥ 235.00 or after 10/09 10:00 AM ET"). */
  summary?: string;
}) {
  const m = useTicketM();
  const a = m.attr;
  // A working order keeps the kinds and mode of its conditions (IB ignores such changes).
  const shapeLock = modifying ? m.locked.conditions : null;
  const onWhy = shapeLock ?? (t.condition ? null : (choices.timing('condition', true) ?? choices.rule({ condition: true }, 'conditions')));
  const cancelWhy = shapeLock ?? (t.condCancel ? null : choices.rule({ condCancel: true }, 'conditions'));
  const setRow = (id: number, p: Partial<TicketCondition>) => patch({ conds: t.conds.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  const kindOptions = CONDITION_KINDS.map((k) => ({ key: k, label: m.condKinds[k], hint: m.condKindHints[k] }));
  const nowLocal = toLocalInput(zonedParts(now, NEW_YORK));

  return (
    <>
      <SwitchRow
        label={m.condition}
        desc={m.conditionDesc}
        on={t.condition}
        disabled={!!onWhy}
        title={onWhy ? m.unavailable(onWhy) : undefined}
        onToggle={() => patch({ condition: !t.condition })}
      />
      {t.condition && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontVariantNumeric: 'tabular-nums' }}>
          {t.conds.map((row, i) => (
            <div key={row.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {i > 0 && (
                <Seg
                  // IB keeps how the conditions of a working order are joined.
                  options={[
                    { key: 'and' as const, label: a.and.toUpperCase(), why: t.conds[i - 1].join === 'and' ? null : shapeLock },
                    { key: 'or' as const, label: a.or.toUpperCase(), why: t.conds[i - 1].join === 'or' ? null : shapeLock },
                  ]}
                  value={t.conds[i - 1].join}
                  onChange={(join) => setRow(t.conds[i - 1].id, { join })}
                  style={{ width: 96, alignSelf: 'center' }}
                />
              )}
              <ConditionRow
                row={row}
                text={model.condTexts[i] ?? ''}
                contract={contract}
                refContract={refContract}
                kindOptions={kindOptions}
                shapeLock={shapeLock}
                removable={t.conds.length > 1 && !shapeLock}
                onChange={(p) => setRow(row.id, p)}
                onRemove={() => patch({ conds: t.conds.filter((c) => c.id !== row.id) })}
                minTime={nowLocal}
                now={now}
              />
            </div>
          ))}
          {t.conds.length < MAX_CONDITIONS && !shapeLock && (
            <div
              onClick={() => patch({ conds: [...t.conds, newCondition()] })}
              className="hover-tx"
              role="button"
              style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--ac)', cursor: 'pointer', padding: '2px 0' }}
            >
              {m.addCondition}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--dm)' }}>{m.whenMet}</div>
            <Seg
              options={[
                { key: 'submit' as const, label: m.condSubmit, why: !t.condCancel ? null : shapeLock },
                { key: 'cancel' as const, label: m.condCancelMode, why: t.condCancel ? null : cancelWhy },
              ]}
              value={t.condCancel ? 'cancel' : 'submit'}
              onChange={(k) => patch({ condCancel: k === 'cancel' })}
            />
          </div>
          <Check on={t.condRth} label={m.conditionRth} onToggle={() => patch({ condRth: !t.condRth })} />
          {summary && <div style={hint11}>{m.condWhen(t.condCancel, summary)}</div>}
        </div>
      )}
    </>
  );
}

function ConditionRow({
  row,
  text,
  contract,
  refContract,
  kindOptions,
  shapeLock,
  removable,
  onChange,
  onRemove,
  minTime,
  now,
}: {
  row: TicketCondition;
  text: string;
  contract: ContractRef;
  refContract: ContractRef;
  kindOptions: Array<{ key: TicketConditionKind; label: string; hint: string }>;
  shapeLock: string | null;
  removable: boolean;
  onChange: (p: Partial<TicketCondition>) => void;
  onRemove: () => void;
  minTime: string;
  now: number;
}) {
  const m = useTicketM();
  const a = m.attr;
  const [timeFocus, setTimeFocus] = useState(false);
  const value = (
    <TextField
      value={text}
      placeholder="—"
      onChange={(v) => onChange({ value: v.replace(/[^\d.,-]/g, '') })}
      onBlur={() => row.kind === 'price' && row.contract == null && row.value === '' && onChange({ value: null })}
    />
  );
  const watched = row.contract ?? refContract;
  // IB keeps the operator of a working order's condition (its value can change).
  const opSeg = <Seg options={ops.map((o) => ({ ...o, why: o.key === row.op ? null : shapeLock }))} value={row.op} onChange={(op) => onChange({ op, ...(row.kind === 'price' && row.contract == null ? { value: null } : {}) })} itemStyle={{ font: '600 13px/26px var(--num)' }} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, background: 'var(--p)', boxShadow: 'inset 0 0 0 1px var(--ln2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Select
          options={kindOptions.map((k) => ({ ...k, why: k.key === row.kind ? null : shapeLock }))}
          value={row.kind}
          onChange={(kind) => onChange({ ...newCondition(kind), id: row.id, join: row.join })}
          disabled={!!shapeLock}
          title={shapeLock ?? m.condKindHints[row.kind]}
          width={240}
          style={{ flex: 1, height: 28, background: 'var(--p2)' }}
        />
        {removable && (
          <div onClick={onRemove} title={m.removeCondition} className="hover-tx" style={{ width: 22, textAlign: 'center', fontSize: 14, color: 'var(--dm)', cursor: 'pointer' }}>
            ×
          </div>
        )}
      </div>
      {(row.kind === 'price' || row.kind === 'percentChange' || row.kind === 'volume') && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 0.85fr 1fr', gap: 6 }}>
          <WatchedSymbol contract={row.contract} fallback={refContract} onPick={(c) => onChange({ contract: c, ...(row.kind === 'price' ? { value: c ? '' : null } : {}) })} />
          {opSeg}
          {value}
        </div>
      )}
      {row.kind === 'percentChange' && <div style={hint11}>{a.condPercent(watched.symbol, row.op === '>=' ? '≥' : '≤', `${text || '—'}`)}</div>}
      {row.kind === 'price' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 6, alignItems: 'center' }}>
          <div style={{ fontSize: 11, color: 'var(--dm)' }}>{m.condTrigger}</div>
          <Select<TriggerMethod>
            options={triggerMethodsFor(watched.secType).map((k) => ({ key: k, label: a.triggerMethods[k] }))}
            value={row.trigger}
            onChange={(trigger) => onChange({ trigger })}
            width={200}
            style={{ height: 28 }}
          />
        </div>
      )}
      {row.kind === 'margin' && (
        <div style={{ display: 'grid', gridTemplateColumns: '0.85fr 1fr', gap: 6 }}>
          {opSeg}
          {value}
        </div>
      )}
      {row.kind === 'time' && (
        <FieldBox focused={timeFocus} style={{ height: 34, justifyContent: 'space-between', gap: 10, padding: '0 10px', background: 'var(--p)' }}>
          <div style={{ fontSize: 11, color: 'var(--dm)', flexShrink: 0 }}>{m.after}</div>
          <DateTimeField value={row.time ?? defaultConditionTime(now)} min={minTime} onChange={(time) => onChange({ time: time || null })} onFocusChange={setTimeFocus} />
        </FieldBox>
      )}
      {row.kind === 'execution' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, alignItems: 'end' }}>
          <Field label={m.symbolPh}>
            <TextField
              value={row.symbol}
              numeric={false}
              placeholder={contract.symbol}
              onChange={(v) => onChange({ symbol: v.toUpperCase().replace(/[^A-Z0-9. ]/g, '').slice(0, 12) })}
              style={{ textAlign: 'left', fontFamily: 'var(--mono)' }}
            />
          </Field>
          <Field label={m.executionOf}>
            <Select<SecType>
              options={EXEC_SEC_TYPES.map((k) => ({ key: k, label: k }))}
              value={row.secType ?? (EXEC_SEC_TYPES.includes(contract.secType) ? contract.secType : 'STK')}
              onChange={(secType) => onChange({ secType })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
