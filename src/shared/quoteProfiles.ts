// Add-on quote profiles: extra generic ticks a view asks for only while it shows them (the Positions
// table's statistics, short-sale, auction, ETF NAV, futures and bond columns). Each one adds its ticks
// to the instrument's basic list; main/market/subscriptions.ts keeps every list within the ticks IB
// accepts (LEGAL_GENERIC_TICKS) and leaves the add-ons out again when IB refuses them (error 321).
//
// The tick lists name only the instrument types a live probe of the paper account saw data for
// (October 2026); a generic tick IB accepts for a type is not always one it answers on it.

import type { SecType } from './types';

export const ADD_ON_PROFILES = ['range', 'volatility', 'optionFlow', 'activity', 'auction', 'vwap', 'mark', 'shortSale', 'etfNav', 'futuresOi', 'bondFactor'] as const;
export type AddOnProfile = (typeof ADD_ON_PROFILES)[number];

export const isAddOnProfile = (v: unknown): v is AddOnProfile => typeof v === 'string' && (ADD_ON_PROFILES as readonly string[]).includes(v);

/**
 * Generic ticks per add-on profile and instrument type (the ticks IB answers with in brackets):
 * - range: 165 (13 / 26 / 52-week lows and highs 15–20, average daily volume 21)
 * - volatility: 106 (30-day implied volatility 24), 411 (real-time historical volatility 58)
 * - optionFlow: 100 (option call / put volume 29 / 30), 101 (open interest 27 / 28), 105 (average
 *   option volume 87)
 * - activity: 293 / 294 / 295 (trade count 54, trades and volume per minute 55 / 56), 595
 *   (3 / 5 / 10-minute volume 63–65)
 * - auction: 225 (auction volume, price, imbalance and regulatory imbalance 34, 35, 36, 61)
 * - vwap: 233 (RTVolume 48, whose fifth field is the day's VWAP)
 * - mark: 221 (mark price 37; option lines carry it already)
 * - shortSale: 236 (shortable 46, shortable shares 89), 499 (borrow fee 111)
 * - etfNav: 577 (NAV 96), 614 (NAV high / low 98 / 99), 623 (frozen NAV 97); ETFs only
 * - futuresOi: 588 (futures open interest 86)
 * - bondFactor: 460 (bond factor multiplier 60)
 */
export const ADD_ON_TICKS: Record<AddOnProfile, Partial<Record<SecType, readonly number[]>>> = {
  range: { STK: [165] },
  volatility: { STK: [106, 411], FUT: [106] },
  optionFlow: { STK: [100, 101, 105], FUT: [101] },
  activity: { STK: [293, 294, 295, 595], FUT: [295] },
  auction: { STK: [225] },
  vwap: { STK: [233] },
  mark: { STK: [221], FUT: [221], CASH: [221], CRYPTO: [221], OPT: [221], FOP: [221] },
  shortSale: { STK: [236, 499] },
  etfNav: { STK: [577, 614, 623] },
  futuresOi: { FUT: [588] },
  bondFactor: { BOND: [460] },
};

/** Whether an add-on profile asks for anything on an instrument type. */
export function addOnApplies(profile: AddOnProfile, secType: SecType): boolean {
  return !!ADD_ON_TICKS[profile][secType]?.length;
}
