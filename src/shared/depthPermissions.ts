// IB's 2152 notice on a SMART depth request lists where the account gets Level 2 and where it
// lacks the permission, e.g. "Exchanges - Depth: IEX; Top: BYX; PEARL; …; Need additional market
// data permissions - Depth: NASDAQ; BATS; ARCA; BEX; NYSE; " or (seen later on the same account)
// "Exchanges - Depth: IEX; Top: EDGEA; Unknown market data permissions - Depth: NASDAQ; …; NYSE;
// Top: BYX; …" (pure, used by main and renderer).

import type { MarketCheckProbe } from './types';

/** IB's notice that Level 2 comes from some exchanges only. */
export const DEPTH_PARTIAL = 2152;

export interface DepthPermissions {
  /** Exchanges that send their book. */
  depth: string[];
  /** Exchanges whose book needs another subscription. */
  missing: string[];
}

const list = (text: string | undefined): string[] =>
  (text ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

/** The exchanges of a 2152 notice; null when the message has no such lists. */
export function depthPermissions(message: string | undefined): DepthPermissions | null {
  if (!message) return null;
  const depth = /Exchanges\s*-\s*Depth:\s*(.*?)(?:\s*Top:|\s*\w+(?: \w+)? market data permissions|$)/i.exec(message)?.[1];
  const missing = /(?:Need additional|Unknown) market data permissions\s*-\s*Depth:\s*(.*?)(?:\s*Top:|$)/i.exec(message)?.[1];
  if (depth == null && missing == null) return null;
  return { depth: list(depth), missing: list(missing) };
}

/** A Level 2 answer of the market data check that is a full book: live, and no 2152 limiting it to some exchanges. */
export function isFullBook(probe: Pick<MarketCheckProbe, 'status' | 'code'>): boolean {
  return probe.status === 'live' && probe.code !== DEPTH_PARTIAL;
}
