// The ticket's "Advanced" section: outside RTH, bracket, price condition, iceberg and good-after-time.

import type { ReactNode } from 'react';
import { pct } from '@shared/format';
import type { TicketState } from '../../state/store';
import { Toggle } from '../../ui/primitives';
import { TextField } from './fields';
import { useTicketM } from './messages';
import type { TicketModel } from './ticketModel';

/** A clickable row with a label (and optional description) and a switch on the right. */
function SwitchRow({ label, desc, on, onToggle, disabled }: { label: ReactNode; desc?: ReactNode; on: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <div
      onClick={disabled ? undefined : onToggle}
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      {desc == null ? (
        <div style={{ fontSize: 13 }}>{label}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ fontSize: 13 }}>{label}</div>
          <div style={{ fontSize: 11, color: 'var(--dm)' }}>{desc}</div>
        </div>
      )}
      <Toggle on={on} disabled={disabled} />
    </div>
  );
}

const signed = (n: number | undefined) => (n == null ? '' : pct(n));
const signedColor = (n: number | undefined) => (n == null ? 'var(--dm)' : n >= 0 ? 'var(--up)' : 'var(--dn)');

export function AdvancedPanel({
  t,
  model,
  patch,
  refSymbol,
  modifying,
}: {
  t: TicketState;
  model: TicketModel;
  patch: (p: Partial<TicketState>) => void;
  /** Symbol whose price the condition watches. */
  refSymbol: string;
  /** Brackets cannot be attached to an existing order. */
  modifying: boolean;
}) {
  const m = useTicketM();
  const op = t.condOp === '>=' ? '≥' : '≤';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, background: 'var(--p2)' }}>
      <SwitchRow label={m.outsideRth} on={t.outsideRth} onToggle={() => patch({ outsideRth: !t.outsideRth })} />
      <SwitchRow label={m.bracket} on={t.bracket && !modifying} disabled={modifying} onToggle={() => patch({ bracket: !t.bracket })} />
      {t.bracket && !modifying && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontVariantNumeric: 'tabular-nums' }}>
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
              <div>{m.stopLoss}</div>
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
      )}
      <SwitchRow label={m.condition} desc={m.conditionDesc} on={t.condition} onToggle={() => patch({ condition: !t.condition })} />
      {t.condition && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontVariantNumeric: 'tabular-nums' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 6 }}>
            <div
              style={{
                height: 34,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 10px',
                boxShadow: 'inset 0 0 0 1px var(--ln)',
                background: 'var(--p)',
                fontSize: 12,
                minWidth: 0,
              }}
            >
              <div style={{ color: 'var(--dm)' }}>{m.ref}</div>
              <div className="ellipsis" style={{ font: '600 12px/1 var(--mono)' }}>
                {refSymbol}
              </div>
            </div>
            <div style={{ display: 'flex', background: 'var(--p)', padding: 2, boxShadow: 'inset 0 0 0 1px var(--ln)' }}>
              {(['>=', '<='] as const).map((k) => (
                <div
                  key={k}
                  onClick={() => patch({ condOp: k, condPx: null })}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    font: '600 13px/1 var(--num)',
                    cursor: 'pointer',
                    background: t.condOp === k ? 'var(--p2)' : 'transparent',
                    color: t.condOp === k ? 'var(--tx)' : 'var(--dm)',
                  }}
                >
                  {k === '>=' ? '≥' : '≤'}
                </div>
              ))}
            </div>
            <TextField value={model.condText} placeholder="—" onChange={(v) => patch({ condPx: v })} onBlur={() => t.condPx === '' && patch({ condPx: null })} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--dm)' }}>
            <div className="ellipsis">{m.conditionHint(refSymbol, op, model.condText || '—')}</div>
            <div onClick={() => patch({ condRth: !t.condRth })} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flexShrink: 0 }}>
              <div>{m.conditionRth}</div>
              <div style={{ width: 12, height: 12, boxShadow: `inset 0 0 0 ${t.condRth ? 4 : 1}px var(--ac)` }} />
            </div>
          </div>
        </div>
      )}
      <SwitchRow label={m.iceberg} desc={m.icebergDesc} on={t.iceberg} onToggle={() => patch({ iceberg: !t.iceberg })} />
      {t.iceberg && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'center' }}>
          <div style={{ fontSize: 11, color: 'var(--dm)' }}>{m.displaySize}</div>
          <TextField value={t.iceQty} onChange={(v) => patch({ iceQty: v.replace(/[^\d]/g, '') })} />
        </div>
      )}
      <SwitchRow label={m.goodAfter} desc={m.goodAfterDesc} on={t.goodAfter} onToggle={() => patch({ goodAfter: !t.goodAfter })} />
      {t.goodAfter && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'center' }}>
          <div style={{ fontSize: 11, color: 'var(--dm)' }}>{m.activateAt}</div>
          <TextField value={t.goodAfterTime} placeholder="09:35" numeric={false} onChange={(v) => patch({ goodAfterTime: v.replace(/[^\d:]/g, '').slice(0, 5) })} />
        </div>
      )}
    </div>
  );
}
