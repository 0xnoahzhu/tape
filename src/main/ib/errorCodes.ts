// Classification of IB error / message codes (the `error` callback carries notices,
// warnings and real errors alike).

/** Farm status codes: market data, HMDS (history) and sec-def farms. */
const FARM_CODES: Record<number, 'ok' | 'inactive' | 'broken'> = {
  2103: 'broken',
  2105: 'broken',
  2157: 'broken',
  2104: 'ok',
  2106: 'ok',
  2158: 'ok',
  2107: 'inactive',
  2108: 'inactive',
};

/** Codes that confirm or annotate something rather than report a failure. */
const NOTICE_CODES = new Set([
  202, // Order cancelled (confirmation of a cancel request)
  399, // Order message, e.g. "Warning: your order will not be placed at the exchange until …"
  404, // Shares not immediately available for short sale; the order is held, not rejected
  10167, // Delayed market data is shown instead of live
  10349, // Order TIF was set to DAY based on the order preset
]);

/** Codes outside 2000–2999 and NOTICE_CODES are real errors (shown red in the API log). */
export function isErrorCode(code: number): boolean {
  if (code >= 2000 && code < 3000) return false;
  return !NOTICE_CODES.has(code);
}

/** 2100–2199 are informational messages (farm status, etc.). */
export function isInfoCode(code: number): boolean {
  return code >= 2100 && code < 2200;
}

/**
 * Farm status from codes 2103–2108 / 2157 / 2158. The farm name is the text after the last
 * ":" ("…connection is OK:usfarm") or after "demand." ("…available upon demand.ushmds").
 */
export function farmUpdate(code: number, message: string): { farm: string; status: 'ok' | 'inactive' | 'broken' } | null {
  const status = FARM_CODES[code];
  if (!status) return null;
  const colon = message.lastIndexOf(':');
  let farm = colon >= 0 ? message.slice(colon + 1) : '';
  if (!farm) {
    const m = /demand\.(.+)$/.exec(message);
    farm = m ? m[1] : '';
  }
  farm = farm.trim();
  return farm ? { farm, status } : null;
}

/**
 * Strips IB's validation prefix: "Error validating request.-'bC' : cause - The API interface is
 * currently in Read-Only mode." -> "The API interface is currently in Read-Only mode."
 */
export function cleanIbMessage(message: string): string {
  return message
    .replace(/^Error validating request\.-'[^']*'\s*:\s*cause\s*-\s*/i, '')
    .trim();
}
