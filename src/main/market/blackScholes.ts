// Black–Scholes prices and greeks for the demo simulator (pure, unit-tested).
// Conventions follow IB's model ticks: iv as a fraction, vega per 1 vol point, theta per day.

export const RISK_FREE = 0.045;

/** Standard normal CDF (Abramowitz–Stegun 26.2.17, |error| < 7.5e-8). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

export function normPdf(x: number): number {
  return 0.3989422804014327 * Math.exp((-x * x) / 2);
}

export interface OptionModel {
  price: number;
  delta: number;
  gamma: number;
  /** Per 1 volatility point (0.01). */
  vega: number;
  /** Per calendar day. */
  theta: number;
}

/**
 * @param S underlying price
 * @param K strike
 * @param T years to expiry
 * @param vol annualized volatility (fraction)
 */
export function blackScholes(S: number, K: number, T: number, vol: number, right: 'C' | 'P', r = RISK_FREE): OptionModel {
  if (T <= 1e-6 || vol <= 0) {
    const intrinsic = right === 'C' ? Math.max(0, S - K) : Math.max(0, K - S);
    const delta = right === 'C' ? (S > K ? 1 : 0) : S < K ? -1 : 0;
    return { price: intrinsic, delta, gamma: 0, vega: 0, theta: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const sT = vol * sqrtT;
  const d1 = (Math.log(S / K) + (r + (vol * vol) / 2) * T) / sT;
  const d2 = d1 - sT;
  const df = Math.exp(-r * T);
  const gamma = normPdf(d1) / (S * sT);
  const vega = (S * normPdf(d1) * sqrtT) / 100;
  const decay = (-S * normPdf(d1) * vol) / (2 * sqrtT);
  if (right === 'C') {
    return {
      price: S * normCdf(d1) - K * df * normCdf(d2),
      delta: normCdf(d1),
      gamma,
      vega,
      theta: (decay - r * K * df * normCdf(d2)) / 365,
    };
  }
  return {
    price: K * df * normCdf(-d2) - S * normCdf(-d1),
    delta: normCdf(d1) - 1,
    gamma,
    vega,
    theta: (decay + r * K * df * normCdf(-d2)) / 365,
  };
}

/**
 * Implied volatility smile used by the simulator: a skewed parabola in moneyness (puts richer
 * than calls) with a mild term structure, as in the design's options desk.
 */
export function smileVol(baseVol: number, S: number, K: number, dte: number): number {
  const m = K / S - 1;
  const term = 1 + 0.06 * Math.log(Math.max(dte, 1) / 30);
  return Math.max(0.05, baseVol * (1 + 1.8 * m * m - 0.45 * m) * term);
}
