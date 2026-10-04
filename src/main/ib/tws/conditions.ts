// Order conditions (Order.conditions). Constructor signatures, fields and the strValue getter
// (the threshold as sent on the wire) match @stoqey/ib's classes.
//
// Wire format follows the IB TWS API (EClient/EDecoder). Portions derived from @stoqey/ib (MIT, Copyright (c) the @stoqey/ib authors)

import { OrderConditionType, type ConjunctionConnection, type TriggerMethod } from './enums.ts';
import type { ContractCondition, OperatorCondition, OrderCondition } from './types.ts';

/** Price of a contract above / below a threshold. */
export class PriceCondition implements ContractCondition {
  price: number;
  triggerMethod: TriggerMethod;
  conId: number | undefined;
  exchange: string | undefined;
  isMore: boolean;
  conjunctionConnection: ConjunctionConnection;
  type: OrderConditionType = OrderConditionType.Price;

  constructor(
    price: number,
    triggerMethod: TriggerMethod,
    conId: number | undefined,
    exchange: string | undefined,
    isMore: boolean,
    conjunctionConnection: ConjunctionConnection,
  ) {
    this.price = price;
    this.triggerMethod = triggerMethod;
    this.conId = conId;
    this.exchange = exchange;
    this.isMore = isMore;
    this.conjunctionConnection = conjunctionConnection;
  }

  get strValue(): string {
    return '' + this.price;
  }
}

/** Current time after / before a given time ("YYYYMMDD HH:MM:SS [tz]"). */
export class TimeCondition implements OperatorCondition {
  time: string;
  isMore: boolean;
  conjunctionConnection: ConjunctionConnection;
  type: OrderConditionType = OrderConditionType.Time;

  constructor(time: string, isMore: boolean, conjunctionConnection: ConjunctionConnection) {
    this.time = time;
    this.isMore = isMore;
    this.conjunctionConnection = conjunctionConnection;
  }

  get strValue(): string {
    return this.time;
  }
}

/** Margin cushion above / below a percentage. */
export class MarginCondition implements OperatorCondition {
  percent: number;
  isMore: boolean;
  conjunctionConnection: ConjunctionConnection;
  type: OrderConditionType = OrderConditionType.Margin;

  constructor(percent: number, isMore: boolean, conjunctionConnection: ConjunctionConnection) {
    this.percent = percent;
    this.isMore = isMore;
    this.conjunctionConnection = conjunctionConnection;
  }

  get strValue(): string {
    return '' + this.percent;
  }
}

/** A trade of the given symbol / security type on the given exchange. */
export class ExecutionCondition implements OrderCondition {
  exchange: string;
  secType: string;
  symbol: string;
  conjunctionConnection: ConjunctionConnection;
  type: OrderConditionType = OrderConditionType.Execution;

  constructor(exchange: string, secType: string, symbol: string, conjunctionConnection: ConjunctionConnection) {
    this.exchange = exchange;
    this.secType = secType;
    this.symbol = symbol;
    this.conjunctionConnection = conjunctionConnection;
  }
}

/** Traded volume of a contract above / below a threshold. */
export class VolumeCondition implements ContractCondition {
  volume: number;
  conId: number;
  exchange: string;
  isMore: boolean;
  conjunctionConnection: ConjunctionConnection;
  type: OrderConditionType = OrderConditionType.Volume;

  constructor(volume: number, conId: number, exchange: string, isMore: boolean, conjunctionConnection: ConjunctionConnection) {
    this.volume = volume;
    this.conId = conId;
    this.exchange = exchange;
    this.isMore = isMore;
    this.conjunctionConnection = conjunctionConnection;
  }

  get strValue(): string {
    return '' + this.volume;
  }
}

/** Percentage change of a contract since the last close above / below a threshold. */
export class PercentChangeCondition implements ContractCondition {
  percent: number;
  conId: number;
  exchange: string;
  isMore: boolean;
  conjunctionConnection: ConjunctionConnection;
  type: OrderConditionType = OrderConditionType.PercentChange;

  constructor(percent: number, conId: number, exchange: string, isMore: boolean, conjunctionConnection: ConjunctionConnection) {
    this.percent = percent;
    this.conId = conId;
    this.exchange = exchange;
    this.isMore = isMore;
    this.conjunctionConnection = conjunctionConnection;
  }

  get strValue(): string {
    return '' + this.percent;
  }
}
