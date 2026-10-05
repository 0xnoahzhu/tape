// The ticket's "Advanced" section: the trading session, then collapsible sections for take-profit /
// stop-loss and the adjustable stop, conditions, fill attributes, trigger method, IB algos,
// routing and OCA groups, good-after time and a note. A closed section sums up what is on in it.
// Choices that do not combine with the rest of the order (shared/orderTiming.ts and
// shared/orderRules.ts) stay visible but inert and say why; what IB does not change on a working
// order is locked while modifying.

export type { Choices } from './controls';

import type { ReactNode } from 'react';
import { pct, px } from '@shared/format';
import { TRIGGER_ORDER_TYPES, triggerMethodsFor, type OrderField } from '@shared/orderRules';
import { TRADING_SESSIONS, unavailableReason, type TimingInput } from '@shared/orderTiming';
import type { ContractRef, OrderRequest, StopOrderType, TradingSession, TriggerMethod, WorkingOrder } from '@shared/types';
import { useClock } from '../../i18n';
import { useCommon } from '../../i18n/common';
import type { AdvancedSection, TicketState } from '../../state/store';
import { adjustText, conditionsShort, conditionsText, fillFlags } from '../orders/attributes';
import { AlgoSection } from './AlgoSection';
import { ConditionsSection } from './ConditionsSection';
import { Field, hint11, Section, Seg, Select, SwitchRow, WallTimeField, type Choices } from './controls';
import { TextField } from './fields';
import { useTicketM } from './messages';
import type { TicketModel } from './ticketModel';

/**
 * Trading session (design-style segmented control, two by two so "Overnight + Day" fits), with a
 * line describing the selected one. Sessions that do not combine with the rest of the order are
 * inert and say why; a working order's session cannot change at all.
 */
function SessionControl({ timing, locked, onChange, rule }: { timing: TimingInput; locked: boolean; onChange: (s: TradingSession) => void; rule: (s: TradingSession) => string | null }) {
  const m = useTicketM();
  const c = useCommon();
  const hints = m.sessionHints(useClock());
  const reason = (k: TradingSession): string | null => {
    if (k === timing.session) return null;
    if (locked) return m.sessionLocked;
    const problem = unavailableReason(timing, 'session', k);
    return problem ? m.problems[problem] : rule(k);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 12 }}>
      <div style={{ fontSize: 13 }}>{m.session}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, padding: 2, background: 'var(--p)', boxShadow: 'inset 0 0 0 1px var(--ln)' }}>
        {TRADING_SESSIONS.map((k) => {
          const on = timing.session === k;
          const why = reason(k);
          return (
            <div
              key={k}
              role="radio"
              aria-checked={on}
              aria-disabled={!!why}
              onClick={why || on ? undefined : () => onChange(k)}
              title={why ? `${hints[k]}\n${m.unavailable(why)}` : hints[k]}
              className="ellipsis"
              style={{
                height: 28,
                lineHeight: '28px',
                textAlign: 'center',
                padding: '0 6px',
                fontSize: 12,
                cursor: why ? 'not-allowed' : 'pointer',
                background: on ? 'var(--p2)' : 'transparent',
                color: on ? 'var(--tx)' : 'var(--dm)',
                opacity: why ? 0.4 : 1,
              }}
            >
              {c.sessions[k]}
            </div>
          );
        })}
      </div>
      <div style={hint11}>{hints[timing.session]}</div>
    </div>
  );
}

/** Why a switch that is off cannot be turned on (null: it can, or it is on). */
type Blocked = (on: boolean, p: Partial<TicketState>, field: OrderField | null, timingField?: 'bracket' | 'condition' | 'iceberg' | 'goodAfter') => string | null;

const signed = (n: number | undefined) => (n == null ? '' : pct(n));
const signedColor = (n: number | undefined) => (n == null ? 'var(--dm)' : n >= 0 ? 'var(--up)' : 'var(--dn)');
const two = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontVariantNumeric: 'tabular-nums' } as const;
const decimal = (v: string) => v.replace(/[^\d.]/g, '');

/** A labeled value field with its own label line. */
function ValueField({ label, value, onChange, onBlur, placeholder, right }: { label: ReactNode; value: string; onChange: (v: string) => void; onBlur?: () => void; placeholder?: string; right?: ReactNode }) {
  return (
    <Field
      label={
        right == null ? (
          label
        ) : (
          <span style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
            <span className="ellipsis">{label}</span>
            {right}
          </span>
        )
      }
    >
      <TextField value={value} placeholder={placeholder ?? '—'} onChange={onChange} onBlur={onBlur} />
    </Field>
  );
}

export function AdvancedPanel({
  t,
  model,
  patch,
  contract,
  refContract,
  timing,
  choices,
  request,
  validExchanges,
  ocaGroups,
  now,
  modified,
}: {
  t: TicketState;
  model: TicketModel;
  patch: (p: Partial<TicketState>) => void;
  /** The ticket's instrument and the one conditions watch by default (the underlying for options). */
  contract: ContractRef;
  refContract: ContractRef;
  /** The ticket as the TIF / session rules see it (with the session in effect). */
  timing: TimingInput;
  choices: Choices;
  /** The order as the ticket would send it (section summaries). */
  request: OrderRequest;
  validExchanges: readonly string[] | undefined;
  /** OCA groups of this client's working orders. */
  ocaGroups: readonly string[];
  now: number;
  /** The working order being modified. */
  modified?: WorkingOrder;
}) {
  const m = useTicketM();
  const clock = useClock();
  const a = m.attr;
  const modifying = t.modifyingOrderId != null;
  const L = m.locked;
  const open = (s: AdvancedSection) => t.advSections.includes(s);
  const toggle = (s: AdvancedSection) => patch({ advSections: open(s) ? t.advSections.filter((x) => x !== s) : [...t.advSections, s] });
  /**
   * Why a switch that is off cannot be turned on with the rest of the order (a bracket with IOC,
   * a condition on a stop order, …); turning one off never conflicts.
   */
  const blocked: Blocked = (on, p, field, timingField) => {
    if (on) return null;
    return (timingField ? choices.timing(timingField, true) : null) ?? (field ? choices.rule(p, field) : null);
  };
  const title = (why: string | null) => (why ? m.unavailable(why) : undefined);

  const bracketOn = t.bracket && !modifying;
  const bracketWhy = modifying ? null : blocked(t.bracket, { bracket: true }, 'bracket', 'bracket');
  // The adjustable stop of a working order cannot be added or removed.
  const adjustLock = modifying ? L.adjust : null;
  const adjustWhy = adjustLock ?? blocked(t.adjust, { adjust: true }, 'adjustStop');
  const trailingSl = t.slType === 'TRAIL' || t.slType === 'TRAIL LIMIT';

  const exitsSummary = [
    ...(request.bracket ? [`${m.tpSlShort} ${px(request.bracket.takeProfit)} / ${px(request.bracket.stopLoss)}`] : []),
    ...(request.adjustStop || request.bracket?.adjust ? [adjustText((request.adjustStop ?? request.bracket?.adjust)!, a)] : []),
  ].join(' · ');
  const fillSummary = fillFlags(request, a, true).join(' · ');
  const isTriggerType = TRIGGER_ORDER_TYPES.includes(t.orderType);
  const isStk = contract.secType === 'STK';
  const isCash = contract.secType === 'CASH';
  const routingSummary = [...(request.oca ? [a.oca(request.oca.group)] : []), ...(request.route ? [a.route(request.route)] : [])].join(' · ');
  const otherSummary = [...(request.goodAfterTime ? [`GAT ${clock.wall(request.goodAfterTime, { zone: 'ET' })}`] : []), ...(request.orderRef ? [a.note(request.orderRef)] : [])].join(' · ');

  const exchanges = (validExchanges?.length ? validExchanges : ['NASDAQ', 'NYSE', 'ARCA', 'BATS', 'IEX', 'EDGX'])
    .filter((x) => x !== 'SMART' && x !== 'OVERNIGHT' && !/^IBKRATS$|^TPLUS/.test(x))
    .slice()
    .sort();
  const routeLock = modifying ? L.route : null;
  const ocaLock = modifying ? L.oca : null;
  const ocaWhy = ocaLock ?? blocked(t.oca, { oca: true }, 'oca');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--p2)' }}>
      <SessionControl timing={timing} locked={modifying} onChange={(session) => patch({ session })} rule={(k) => choices.rule({ session: k }, 'session')} />

      <Section title={m.sections.exits} summary={open('exits') ? undefined : exitsSummary} open={open('exits')} onToggle={() => toggle('exits')} testId="exits">
        <SwitchRow
          label={m.bracket}
          on={bracketOn}
          disabled={modifying || !!bracketWhy}
          title={title(bracketWhy)}
          onToggle={() => patch({ bracket: !t.bracket })}
        />
        {bracketOn && (
          <>
            <div style={two}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dm)' }}>
                  <div>{m.takeProfit}</div>
                  <div style={{ color: signedColor(model.takeProfitPct) }}>{signed(model.takeProfitPct)}</div>
                </div>
                <TextField
                  value={model.takeProfitText}
                  placeholder="—"
                  onChange={(v) => patch({ takeProfit: v })}
                  onBlur={() => t.takeProfit === '' && patch({ takeProfit: null })}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dm)' }}>
                  <div>{trailingSl ? m.slInitial : m.stopLoss}</div>
                  <div style={{ color: signedColor(model.stopLossPct) }}>{signed(model.stopLossPct)}</div>
                </div>
                <TextField
                  value={model.stopLossText}
                  placeholder="—"
                  onChange={(v) => patch({ stopLoss: v })}
                  onBlur={() => t.stopLoss === '' && patch({ stopLoss: null })}
                />
              </div>
            </div>
            <Field label={m.stopType}>
              <Seg<StopOrderType>
                options={(['STP', 'STP LMT', 'TRAIL', 'TRAIL LIMIT'] as const).map((k) => ({
                  key: k,
                  label: m.stopTypesShort[k],
                  title: m.stopTypes[k],
                  why: k === t.slType ? null : choices.rule({ slType: k }, 'bracket'),
                }))}
                value={t.slType}
                onChange={(slType) => patch({ slType, slLimit: null, slOffset: null })}
              />
            </Field>
            {t.slType === 'STP LMT' && (
              <div style={two}>
                <div />
                <ValueField label={m.slLimit} value={model.slLimitText} onChange={(v) => patch({ slLimit: v })} onBlur={() => t.slLimit === '' && patch({ slLimit: null })} />
              </div>
            )}
            {trailingSl && (
              <div style={two}>
                <Field label={m.trailBy}>
                  <Seg
                    options={[
                      { key: 'pct', label: '%' },
                      { key: 'amt', label: '$' },
                    ]}
                    value={t.slTrailMode}
                    onChange={(slTrailMode) => patch({ slTrailMode })}
                  />
                </Field>
                <ValueField label={t.slTrailMode === 'pct' ? m.trailPct : m.trailAmt} value={t.slTrail} onChange={(v) => patch({ slTrail: decimal(v) })} />
              </div>
            )}
            {t.slType === 'TRAIL LIMIT' && (
              <div style={two}>
                <div />
                <ValueField label={m.slOffset} value={model.slOffsetText} onChange={(v) => patch({ slOffset: v })} onBlur={() => t.slOffset === '' && patch({ slOffset: null })} />
              </div>
            )}
          </>
        )}
        <SwitchRow
          label={m.adjust}
          desc={bracketOn ? m.adjustBracket : m.adjustDesc}
          on={t.adjust}
          disabled={!!adjustWhy}
          title={title(adjustWhy)}
          onToggle={() => patch({ adjust: !t.adjust })}
        />
        {t.adjust && (
          <>
            <div style={two}>
              <ValueField label={m.adjWhen} value={model.adjTriggerText} onChange={(v) => patch({ adjTrigger: v })} onBlur={() => t.adjTrigger === '' && patch({ adjTrigger: null })} />
              <Field label={m.adjThen}>
                <Select
                  options={(['STP', 'STP LMT', 'TRAIL'] as const).map((k) => ({ key: k, label: m.adjTypes[k] }))}
                  value={t.adjType}
                  onChange={(adjType) => patch({ adjType })}
                />
              </Field>
            </div>
            {t.adjType !== 'TRAIL' ? (
              <div style={two}>
                <ValueField label={m.adjStop} value={model.adjStopText} onChange={(v) => patch({ adjStop: v })} onBlur={() => t.adjStop === '' && patch({ adjStop: null })} />
                {t.adjType === 'STP LMT' ? (
                  <ValueField label={m.adjLimit} value={model.adjLimitText} onChange={(v) => patch({ adjLimit: v })} onBlur={() => t.adjLimit === '' && patch({ adjLimit: null })} />
                ) : (
                  <div />
                )}
              </div>
            ) : (
              <div style={two}>
                <Field label={m.adjTrail}>
                  <Seg
                    options={[
                      { key: 'percent', label: '%' },
                      { key: 'amount', label: '$' },
                    ]}
                    value={t.adjTrailUnit}
                    onChange={(adjTrailUnit) => patch({ adjTrailUnit })}
                  />
                </Field>
                <ValueField label={t.adjTrailUnit === 'percent' ? m.trailPct : m.trailAmt} value={t.adjTrail} onChange={(v) => patch({ adjTrail: decimal(v) })} />
              </div>
            )}
          </>
        )}
      </Section>

      <Section
        title={m.sections.conditions}
        summary={open('conditions') || !request.conditions ? undefined : conditionsShort(request.conditions, a, clock)}
        open={open('conditions')}
        onToggle={() => toggle('conditions')}
        testId="conditions"
      >
        <ConditionsSection
          t={t}
          model={model}
          patch={patch}
          contract={contract}
          refContract={refContract}
          modifying={modifying}
          choices={choices}
          now={now}
          summary={request.conditions ? conditionsText(request.conditions, a, clock) : undefined}
        />
      </Section>

      <Section title={m.sections.fill} summary={open('fill') ? undefined : fillSummary} open={open('fill')} onToggle={() => toggle('fill')} testId="fill">
        <FillSection t={t} patch={patch} blocked={blocked} contract={contract} modifying={modifying} modified={modified} />
      </Section>

      {isTriggerType && (
        <Section
          title={m.sections.trigger}
          summary={open('trigger') || !t.triggerMethod ? undefined : a.triggerMethods[t.triggerMethod]}
          open={open('trigger')}
          onToggle={() => toggle('trigger')}
          testId="trigger"
        >
          <Select<TriggerMethod>
            options={triggerMethodsFor(contract.secType).map((k) => ({
              key: k,
              label: k === 0 && (contract.secType === 'OPT' || contract.secType === 'FOP') ? m.triggerOptionDefault : a.triggerMethods[k],
              why: k === t.triggerMethod ? null : choices.rule({ triggerMethod: k }, 'triggerMethod'),
            }))}
            value={t.triggerMethod}
            onChange={(triggerMethod) => patch({ triggerMethod })}
            disabled={modifying}
            title={modifying ? L.triggerMethod : undefined}
          />
          <div style={hint11}>{m.triggerDesc}</div>
        </Section>
      )}

      <AlgoSection
        t={t}
        patch={patch}
        contract={contract}
        choices={choices}
        locked={modifying ? L.algo : null}
        open={open('algo')}
        onToggle={() => toggle('algo')}
      />

      <Section title={m.sections.routing} summary={open('routing') ? undefined : routingSummary} open={open('routing')} onToggle={() => toggle('routing')} testId="routing">
        <SwitchRow label={m.oca} desc={m.ocaDesc} on={t.oca} disabled={!!ocaWhy} title={title(ocaWhy)} onToggle={() => patch({ oca: !t.oca })} />
        {t.oca && (
          <>
            <Field label={m.ocaGroup}>
              <TextField
                value={t.ocaGroup}
                numeric={false}
                placeholder="—"
                onChange={(v) => !ocaLock && patch({ ocaGroup: v.slice(0, 40) })}
                style={{ textAlign: 'left', fontFamily: 'var(--sans)' }}
              />
            </Field>
            {/* Full width: the types differ at the end of their names ("Reduce the others (block)"). */}
            <Field label={m.ocaWhen}>
              <Select
                options={([1, 2, 3] as const).map((k) => ({ key: k, label: a.ocaTypes[k] }))}
                value={t.ocaType}
                onChange={(ocaType) => patch({ ocaType })}
                disabled={!!ocaLock}
                title={ocaLock ?? undefined}
              />
            </Field>
            {ocaGroups.length > 0 && !ocaLock && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11, color: 'var(--dm)' }}>
                <div>{m.ocaYours}</div>
                {ocaGroups.map((g) => (
                  <div
                    key={g}
                    onClick={() => patch({ ocaGroup: g })}
                    style={{ padding: '3px 8px', cursor: 'pointer', boxShadow: `inset 0 0 0 1px ${t.ocaGroup === g ? 'var(--ac)' : 'var(--ln)'}`, color: t.ocaGroup === g ? 'var(--tx)' : 'var(--mu)' }}
                  >
                    {g}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {isStk && (
          <Field label={m.route}>
            <Select<string>
              options={['SMART', ...exchanges].map((x) => ({ key: x, label: x, why: x === t.route ? null : (routeLock ?? choices.rule({ route: x }, 'route')) }))}
              value={t.route}
              onChange={(route) => patch({ route })}
              disabled={!!routeLock}
              title={routeLock ?? m.routeDesc}
            />
            <div style={hint11}>{m.routeDesc}</div>
          </Field>
        )}
        {isCash && <div style={hint11}>{m.routeDesc}</div>}
      </Section>

      <Section title={m.sections.other} summary={open('other') ? undefined : otherSummary} open={open('other')} onToggle={() => toggle('other')} testId="other">
        <GoodAfter
          t={t}
          patch={patch}
          // IB keeps the good-after time of a working order when it is not sent.
          blocked={modifying && t.goodAfter && modified?.goodAfterTime ? L.clear : blocked(t.goodAfter, { goodAfter: true }, 'goodAfter', 'goodAfter')}
        />
        <Field label={m.note}>
          <TextField value={t.orderRef} numeric={false} placeholder={m.notePh} onChange={(v) => patch({ orderRef: v.slice(0, 60) })} style={{ textAlign: 'left', fontFamily: 'var(--sans)' }} />
        </Field>
      </Section>
    </div>
  );
}

function GoodAfter({ t, patch, blocked }: { t: TicketState; patch: (p: Partial<TicketState>) => void; blocked: string | null }) {
  const m = useTicketM();
  return (
    <>
      <SwitchRow
        label={m.goodAfter}
        desc={m.goodAfterDesc}
        on={t.goodAfter}
        disabled={!!blocked}
        title={blocked ? m.unavailable(blocked) : undefined}
        onToggle={() => patch({ goodAfter: !t.goodAfter })}
      />
      {t.goodAfter && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'center' }}>
          <div style={{ fontSize: 11, color: 'var(--dm)' }}>{m.activateAt}</div>
          <WallTimeField value={t.goodAfterTime} onChange={(goodAfterTime) => patch({ goodAfterTime })} />
        </div>
      )}
    </>
  );
}

/** All or none, minimum quantity, hidden, sweep to fill, discretionary amount, iceberg, cash quantity. */
function FillSection({
  t,
  patch,
  blocked,
  contract,
  modifying,
  modified,
}: {
  t: TicketState;
  patch: (p: Partial<TicketState>) => void;
  blocked: Blocked;
  contract: ContractRef;
  modifying: boolean;
  modified?: WorkingOrder;
}) {
  const m = useTicketM();
  const title = (why: string | null) => (why ? m.unavailable(why) : undefined);
  const aonWhy = blocked(t.allOrNone, { allOrNone: true }, 'allOrNone');
  const minWhy = blocked(t.minQtyOn, { minQtyOn: true }, 'minQty');
  const hiddenWhy = blocked(t.hidden, { hidden: true }, 'hidden');
  // IB keeps sweep to fill and a discretionary amount of a working order (see orderRules › modifyProblems).
  const sweepWhy = modifying ? m.locked.sweep : blocked(t.sweep, { sweep: true }, 'sweepToFill');
  const discWhy = modifying && t.disc && modified?.discretionaryAmt ? m.locked.clear : blocked(t.disc, { disc: true }, 'discretionary');
  const iceWhy = blocked(t.iceberg, { iceberg: true }, 'iceberg', 'iceberg');
  const cashWhy = modifying ? m.locked.cashQty : blocked(t.cashQtyOn, { cashQtyOn: true }, 'cashQty');
  const row = (label: string, value: string, onChange: (v: string) => void) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'center' }}>
      <div style={{ fontSize: 11, color: 'var(--dm)' }}>{label}</div>
      <TextField value={value} onChange={onChange} />
    </div>
  );
  return (
    <>
      <SwitchRow label={m.aon} desc={m.aonDesc} on={t.allOrNone} disabled={!!aonWhy} title={title(aonWhy)} onToggle={() => patch({ allOrNone: !t.allOrNone })} />
      <SwitchRow label={m.minQty} desc={m.minQtyDesc} on={t.minQtyOn} disabled={!!minWhy} title={title(minWhy)} onToggle={() => patch({ minQtyOn: !t.minQtyOn })} />
      {t.minQtyOn && row(m.minQty, t.minQty, (v) => patch({ minQty: v.replace(/[^\d]/g, '') }))}
      <SwitchRow label={m.hidden} desc={m.hiddenDesc} on={t.hidden} disabled={!!hiddenWhy} title={title(hiddenWhy)} onToggle={() => patch({ hidden: !t.hidden })} />
      <SwitchRow label={m.sweep} desc={m.sweepDesc} on={t.sweep} disabled={!!sweepWhy} title={title(sweepWhy)} onToggle={() => patch({ sweep: !t.sweep })} />
      <SwitchRow label={m.disc} desc={m.discDesc} on={t.disc} disabled={!!discWhy} title={title(discWhy)} onToggle={() => patch({ disc: !t.disc })} />
      {t.disc && row(m.disc, t.discAmt, (v) => patch({ discAmt: decimal(v) }))}
      <SwitchRow label={m.iceberg} desc={m.icebergDesc} on={t.iceberg} disabled={!!iceWhy} title={title(iceWhy)} onToggle={() => patch({ iceberg: !t.iceberg })} />
      {t.iceberg && row(m.displaySize, t.iceQty, (v) => patch({ iceQty: v.replace(/[^\d]/g, '') }))}
      {contract.secType === 'CASH' && (
        <SwitchRow label={m.cashQty(contract.currency)} desc={m.cashQtyDesc} on={t.cashQtyOn} disabled={!!cashWhy} title={title(cashWhy)} onToggle={() => patch({ cashQtyOn: !t.cashQtyOn })} />
      )}
    </>
  );
}
