// IB's 2152 notice on a SMART depth request lists where the account gets Level 2 and where it
// lacks the permission, e.g. "Exchanges - Depth: IEX; Top: BYX; PEARL; …; Need additional market
// data permissions - Depth: NASDAQ; BATS; ARCA; BEX; NYSE; " (pure, used by main and renderer).

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
  const depth = /Exchanges\s*-\s*Depth:\s*(.*?)(?:\s*Top:|\s*Need additional|$)/i.exec(message)?.[1];
  const missing = /Need additional market data permissions\s*-\s*Depth:\s*(.*)$/i.exec(message)?.[1];
  if (depth == null && missing == null) return null;
  return { depth: list(depth), missing: list(missing) };
}
