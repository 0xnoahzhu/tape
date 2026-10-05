import { describe, expect, it } from 'vitest';
import { stock } from '@shared/contract';
import { algoDefaults, typedAlgoParams } from './algo';
import { conditionRows, defaultConditionTime, newCondition } from './ticketConditions';

describe('condition rows', () => {
  it('start with values that IB takes', () => {
    expect(newCondition()).toMatchObject({ kind: 'price', op: '>=', value: null, contract: null, trigger: 0, join: 'and' });
    expect(newCondition('margin')).toMatchObject({ op: '<=', value: '30' });
    expect(newCondition('percentChange').value).toBe('5');
    expect(newCondition().id).not.toBe(newCondition().id);
  });

  it('default a time an hour ahead, on a quarter hour, in New York', () => {
    // 10:07 New York (EDT) -> 11:15.
    expect(defaultConditionTime(Date.UTC(2026, 9, 5, 14, 7))).toBe('2026-10-05T11:15');
  });

  it('load a working order’s conditions with their instruments', () => {
    const spy = { ...stock('SPY'), conId: 756733 };
    const rows = conditionRows({
      items: [
        { kind: 'price', contract: spy, operator: '<=', price: 600, triggerMethod: 2, join: 'or' },
        { kind: 'time', time: '20261009 10:30:00 US/Eastern', join: 'and' },
        { kind: 'execution', symbol: 'MSFT', secType: 'STK' },
      ],
      outsideRth: false,
    });
    expect(rows.map((r) => [r.kind, r.op, r.value, r.contract?.symbol, r.trigger, r.time, r.symbol, r.join])).toEqual([
      ['price', '<=', '600', 'SPY', 2, null, '', 'or'],
      ['time', '>=', '', undefined, 0, '2026-10-09T10:30', '', 'and'],
      ['execution', '>=', '', undefined, 0, null, 'MSFT', 'and'],
    ]);
    expect(conditionRows(undefined)).toHaveLength(1);
  });
});

describe('algo parameters in the ticket', () => {
  it('start with the required ones', () => {
    expect(algoDefaults('Adaptive', 100)).toEqual({ adaptivePriority: 'Normal' });
    expect(algoDefaults('DarkIce', 40)).toEqual({ displaySize: '40' });
    expect(algoDefaults('AD', 1000)).toEqual({ componentSize: '100', timeBetweenOrders: '60' });
    expect(algoDefaults('Vwap', 100)).toEqual({});
  });

  it('load IB fractions as percentages', () => {
    expect(typedAlgoParams({ strategy: 'Vwap', params: { maxPctVol: 0.125, startTime: '09:45', noTakeLiq: true, unknownTag: 'x' } })).toEqual({ maxPctVol: '12.5', startTime: '09:45', noTakeLiq: true });
  });
});

describe('condition wording', () => {
  it('reads as a sentence in both languages', async () => {
    const { useTicketM } = await import('./messages');
    const en = useTicketM.for('en');
    const zh = useTicketM.for('zh');
    expect(en.condWhen(false, en.attr.condExecution('MSFT', 'STK'))).toBe('Submit when you trade MSFT (STK)');
    expect(zh.condWhen(true, zh.attr.condExecution('MSFT', 'STK'))).toBe('当本账户成交 MSFT（STK）时撤销此单');
    expect(zh.condWhen(false, 'AAPL ≥ 235.00')).toBe('当 AAPL ≥ 235.00 时提交此单');
    expect(zh.algoTime('开始')).toBe('开始（美东）');
  });
});
