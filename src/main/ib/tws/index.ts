// Dependency-free TWS / IB Gateway API client (node:net + node:events only).
//
// A drop-in replacement for the parts of @stoqey/ib Tape uses: `import { IBApi, EventName,
// type Contract } from './tws'` instead of '@stoqey/ib'. Protocol: server versions 176..193
// (plain text, TWS / IB Gateway 10.x), see messageIds.ts.
//
// Wire format follows the IB TWS API (EClient/EDecoder). Portions derived from @stoqey/ib (MIT, Copyright (c) the @stoqey/ib authors). See THIRD_PARTY_NOTICE.md.

export { IBApi, IBApi as TwsClient, type IBApiEventMap, type IBApiQueueStats } from './client.ts';
export { DEFAULT_MAX_PER_SECOND, Lane, laneOf, type QueueStats } from './sendQueue.ts';
export {
  EventName,
  SecType,
  OptionType,
  OrderAction,
  OrderType,
  TimeInForce,
  OrderStatus,
  OrderConditionType,
  ConjunctionConnection,
  TriggerMethod,
  Liquidities,
  MarketDataType,
  BarSizeSetting,
  WhatToShow,
  COMPETE_AGAINST_BEST_OFFSET_UP_TO_MID,
  isPegBenchOrder,
  isPegBestOrder,
  isPegMidOrder,
  isVolOrder,
  numericEnum,
  type NumericEnum,
} from './enums.ts';
export { TickType, IBApiTickType } from './tickTypes.ts';
export { ErrorCode, isNonFatalError, TwsEncodeError } from './errors.ts';
export {
  IN_MSG_ID,
  OUT_MSG_ID,
  MIN_SERVER_VER,
  MIN_SERVER_VERSION,
  MAX_SERVER_VERSION,
  MIN_SERVER_VER_SUPPORTED,
  MAX_SUPPORTED_SERVER_VERSION,
} from './messageIds.ts';
export { PriceCondition, TimeCondition, MarginCondition, ExecutionCondition, VolumeCondition, PercentChangeCondition } from './conditions.ts';
export { decodeMessage, isDecodedMessage, type DecodedEvent } from './decoder.ts';
export { Encoder, frameText, toTokens, type EncoderCallbacks, type Token } from './encoder.ts';
export type {
  Bar,
  ComboLeg,
  CommissionReport,
  Contract,
  ContractCondition,
  ContractDescription,
  ContractDetails,
  DeltaNeutralContract,
  DepthMktDataDescription,
  Execution,
  ExecutionFilter,
  IBApiCreationOptions,
  IneligibilityReason,
  OperatorCondition,
  Order,
  OrderCancel,
  OrderComboLeg,
  OrderCondition,
  OrderState,
  SoftDollarTier,
  TagValue,
} from './types.ts';
