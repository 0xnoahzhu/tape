// Rows of the ticket's conditions editor: new rows, the default time of a time condition, and the
// conversion from the conditions of a working order (Modify). Pure, so it can be unit tested.

import { NEW_YORK, parseIbDateTime, zonedParts } from '@shared/orderTiming';
import type { OrderConditions } from '@shared/types';
import type { TicketCondition, TicketConditionKind } from '../../state/store';
import { toLocalInput } from './timing';

export const CONDITION_KINDS: readonly TicketConditionKind[] = ['price', 'time', 'percentChange', 'volume', 'margin', 'execution'];

let seq = 1;

/** A new condition row of `kind` (a price row watching the ticket's reference by default). */
export function newCondition(kind: TicketConditionKind = 'price', patch: Partial<TicketCondition> = {}): TicketCondition {
  const value = kind === 'price' ? null : kind === 'percentChange' ? '5' : kind === 'volume' ? '1000000' : kind === 'margin' ? '30' : '';
  return { id: seq++, kind, op: kind === 'margin' ? '<=' : '>=', value, contract: null, trigger: 0, time: null, symbol: '', secType: null, join: 'and', ...patch };
}

/** Default time of a time condition: the next whole quarter hour at least an hour from now (New York). */
export function defaultConditionTime(now: number): string {
  const quarter = 15 * 60_000;
  return toLocalInput(zonedParts(Math.ceil((now + 3_600_000) / quarter) * quarter, NEW_YORK));
}

/** A working order's conditions as editor rows (Modify), with their watched instruments kept. */
export function conditionRows(c: OrderConditions | undefined): TicketCondition[] {
  if (!c?.items.length) return [newCondition()];
  return c.items.map((i) => {
    const join = i.join ?? 'and';
    switch (i.kind) {
      case 'price':
        return newCondition('price', { op: i.operator, value: String(i.price), contract: i.contract, trigger: i.triggerMethod ?? 0, join });
      case 'percentChange':
        return newCondition('percentChange', { op: i.operator, value: String(i.percent), contract: i.contract, join });
      case 'volume':
        return newCondition('volume', { op: i.operator, value: String(i.volume), contract: i.contract, join });
      case 'margin':
        return newCondition('margin', { op: i.operator, value: String(i.percent), join });
      case 'time': {
        const at = parseIbDateTime(i.time);
        return newCondition('time', { time: at != null ? toLocalInput(zonedParts(at, NEW_YORK)) : null, join });
      }
      case 'execution':
        return newCondition('execution', { symbol: i.symbol, secType: i.secType, join });
    }
  });
}
