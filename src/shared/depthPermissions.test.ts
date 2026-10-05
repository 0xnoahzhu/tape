import { describe, expect, it } from 'vitest';
import { depthPermissions } from './depthPermissions';

describe('depthPermissions', () => {
  it('reads the exchanges of IB’s 2152 notice (as seen on the paper account)', () => {
    const msg =
      'Exchanges - Depth: IEX; Top: BYX; PEARL; AMEX; T24X; MEMX; OVERNIGHT; EDGEA; TXSE; CHX; IBEOS; NYSENAT; PSX; LTSE; ISE; DRCTEDGE; Need additional market data permissions - Depth: NASDAQ; BATS; ARCA; BEX; NYSE; ';
    expect(depthPermissions(msg)).toEqual({ depth: ['IEX'], missing: ['NASDAQ', 'BATS', 'ARCA', 'BEX', 'NYSE'] });
  });

  it('reads the "Unknown market data permissions" form with top-of-book exchanges after it', () => {
    const msg =
      'Exchanges - Depth: IEX; Top: EDGEA; Unknown market data permissions - Depth: NASDAQ; BATS; ARCA; BEX; NYSE; Top: BYX; AMEX; PEARL; T24X; MEMX; OVERNIGHT; TXSE; CHX; NYSENAT; IBEOS; PSX; LTSE; ISE; DRCTEDGE; ';
    expect(depthPermissions(msg)).toEqual({ depth: ['IEX'], missing: ['NASDAQ', 'BATS', 'ARCA', 'BEX', 'NYSE'] });
  });

  it('copes with a part missing and with other messages', () => {
    expect(depthPermissions('Exchanges - Depth: IEX; NASDAQ; Top: ARCA;')).toEqual({ depth: ['IEX', 'NASDAQ'], missing: [] });
    expect(depthPermissions('Need additional market data permissions - Depth: NYSE;')).toEqual({ depth: [], missing: ['NYSE'] });
    expect(depthPermissions('Market depth data has been RESET')).toBeNull();
    expect(depthPermissions(undefined)).toBeNull();
  });
});
