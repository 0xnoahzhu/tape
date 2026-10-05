// The IB algo section of the ticket's Advanced panel: the algo (offered for the instrument) and
// a compact form of its parameters. IB algos work in regular hours on market and limit orders;
// a working order keeps its algo, only the parameters change.

import { ALGOS, type AlgoParam } from '@shared/orderRules';
import type { AlgoStrategy, ContractRef } from '@shared/types';
import type { TicketState } from '../../state/store';
import { algoDefaults } from './algo';
import { Check, Field, hint11, Section, Seg, Select, WallTimeField, type Choices } from './controls';
import { TextField } from './fields';
import { useTicketM } from './messages';

export function AlgoSection({
  t,
  patch,
  contract,
  choices,
  locked,
  open,
  onToggle,
}: {
  t: TicketState;
  patch: (p: Partial<TicketState>) => void;
  contract: ContractRef;
  choices: Choices;
  /** Why the algo cannot change (a working order); its parameters still can. */
  locked: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const m = useTicketM();
  const a = m.attr;
  const offered = ALGOS.filter((x) => x.secTypes.includes(contract.secType));
  if (!offered.length && !t.algo) return null;
  const info = ALGOS.find((x) => x.strategy === t.algo);
  const choose = (k: AlgoStrategy | '') => patch(k ? { algo: k, algoParams: algoDefaults(k, t.qty) } : { algo: null, algoParams: {} });
  const setParam = (tag: string, v: string | boolean) => patch({ algoParams: { ...t.algoParams, [tag]: v } });
  const params = info?.params ?? [];
  const values = params.filter((p) => p.kind !== 'switch');
  const switches = params.filter((p) => p.kind === 'switch');
  const control = (p: AlgoParam) => {
    const v = t.algoParams[p.tag];
    const text = typeof v === 'string' ? v : '';
    switch (p.kind) {
      case 'choice': {
        const options = (p.options ?? []).map((o) => ({ key: o, label: a.algoChoices[o] ?? o }));
        return options.length <= 3 ? (
          <Seg options={options} value={text || options[0].key} onChange={(k) => setParam(p.tag, k)} />
        ) : (
          <Select options={[{ key: '', label: '—' }, ...options]} value={text} onChange={(k) => setParam(p.tag, k)} />
        );
      }
      case 'time':
        return <WallTimeField value={text} placeholder="—" onChange={(x) => setParam(p.tag, x)} />;
      case 'fraction':
        return <TextField value={text} placeholder={p.required ? '%' : '—'} onChange={(x) => setParam(p.tag, x.replace(/[^\d.]/g, ''))} />;
      default:
        return <TextField value={text} placeholder="—" onChange={(x) => setParam(p.tag, x.replace(/[^\d]/g, ''))} />;
    }
  };
  const label = (p: AlgoParam) => {
    const name = a.algoParams[p.tag] ?? p.tag;
    if (p.kind === 'fraction') return m.algoPct(name);
    if (p.kind === 'time') return m.algoTime(name);
    return name;
  };
  return (
    <Section title={m.sections.algo} summary={open || !t.algo ? undefined : (a.algos[t.algo] ?? t.algo)} open={open} onToggle={onToggle} testId="algo">
      <Select<AlgoStrategy | ''>
        options={[
          { key: '' as const, label: m.algoNone, why: !t.algo ? null : locked },
          ...offered.map((x) => ({
            key: x.strategy,
            label: a.algos[x.strategy] ?? x.strategy,
            why: x.strategy === t.algo ? null : (locked ?? choices.rule({ algo: x.strategy, algoParams: algoDefaults(x.strategy, t.qty) }, 'algo')),
          })),
        ]}
        value={t.algo ?? ''}
        onChange={choose}
        disabled={!!locked}
        title={locked ?? undefined}
      />
      {info && params.length > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {values.map((p) => (
              <Field key={p.tag} label={label(p)} style={p.kind === 'choice' && (p.options?.length ?? 0) <= 3 ? { gridColumn: '1 / 3' } : undefined}>
                {control(p)}
              </Field>
            ))}
          </div>
          {switches.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 14px' }}>
              {switches.map((p) => (
                <Check key={p.tag} on={t.algoParams[p.tag] === true} label={a.algoParams[p.tag] ?? p.tag} onToggle={() => setParam(p.tag, t.algoParams[p.tag] !== true)} />
              ))}
            </div>
          )}
        </>
      )}
      <div style={hint11}>{m.algoDesc}</div>
    </Section>
  );
}
