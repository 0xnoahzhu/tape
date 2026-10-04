// Error codes reported through the `error` / `info` events. Codes 501..586 are produced by
// this client itself (connection and encoding problems); the others come from TWS / IB Gateway.
// Values match @stoqey/ib's ErrorCode.
//
// Wire format follows the IB TWS API (EClient/EDecoder). Portions derived from @stoqey/ib (MIT, Copyright (c) the @stoqey/ib authors)

const ERROR_CODE = {
  /** No request id associated with the error. */
  NO_VALID_ID: -1,
  ORDER_CANCELLED: 202,
  MISSING_ORDER_EXCHANGE: 321,
  REQ_MKT_DATA_NOT_AVAIL: 354,
  ORDER_MESSAGE: 399,
  NO_TRADING_PERMISSIONS: 460,
  SCANNER_LOW_PRECISION: 492,
  ALREADY_CONNECTED: 501,
  CONNECT_FAIL: 502,
  UPDATE_TWS: 503,
  NOT_CONNECTED: 504,
  UNKNOWN_ID: 505,
  UNSUPPORTED_VERSION: 506,
  BAD_LENGTH: 507,
  BAD_MESSAGE: 508,
  FAIL_SEND: 509,
  FAIL_SEND_REQMKT: 510,
  FAIL_SEND_CANMKT: 511,
  FAIL_SEND_ORDER: 512,
  FAIL_SEND_ACCT: 513,
  FAIL_SEND_EXEC: 514,
  FAIL_SEND_CORDER: 515,
  FAIL_SEND_OORDER: 516,
  UNKNOWN_CONTRACT: 517,
  FAIL_SEND_REQCONTRACT: 518,
  FAIL_SEND_REQMKTDEPTH: 519,
  FAIL_SEND_CANMKTDEPTH: 520,
  FAIL_SEND_STARTAPI: 550,
  FAIL_READ_MESSAGE: 586,
  FAIL_CONNECTION_LOST_BETWEEN_SERVER_AND_TWS: 1100,
  CONNECTIVITY_RESTORED_DATA_LOST: 1101,
  CONNECTIVITY_RESTORED_DATA_MAINTAINED: 1102,
  FAIL_CONNECTION_LOST_BETWEEN_TWS_AND_SERVER: 2110,
  INVALID_POSITION_TRADE_DERIVATED_VALUE: 2150,
  PART_OF_REQUESTED_DATA_NOT_SUBSCRIBED: 10090,
  DISPLAYING_DELAYED_DATA: 10167,
  NEWS_FEED_NOT_ALLOWED: 10276,
} as const;

export const ErrorCode = Object.freeze(ERROR_CODE);
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/** True for messages that only inform or warn and do not end the request (same rule as @stoqey/ib). */
export function isNonFatalError(code: number, error: Error): boolean {
  if (code >= 2100 && code < 3000) return true;
  if (error.message.includes('Warning:')) return true;
  switch (code) {
    case ErrorCode.PART_OF_REQUESTED_DATA_NOT_SUBSCRIBED:
    case ErrorCode.DISPLAYING_DELAYED_DATA:
    case ErrorCode.ORDER_MESSAGE:
    case ErrorCode.SCANNER_LOW_PRECISION:
      return true;
    default:
      return false;
  }
}

/**
 * A request that cannot be encoded for the connected server version (for example an order
 * attribute the server does not support yet). Reported as an `error` event, never sent.
 */
export class TwsEncodeError extends Error {
  readonly code: number;
  readonly reqId: number;

  constructor(serverVersion: number, message: string, code: number = ErrorCode.UPDATE_TWS, reqId: number = ErrorCode.NO_VALID_ID) {
    super(`Server Version ${serverVersion}: ${message}`);
    this.name = 'TwsEncodeError';
    this.code = code;
    this.reqId = reqId;
  }
}
