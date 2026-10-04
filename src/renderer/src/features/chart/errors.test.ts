import { describe, expect, it } from 'vitest';
import { historyErrorMessage, ipcErrorMessage } from './errors';

describe('IPC error messages', () => {
  it('strips the Electron wrapper and the error class', () => {
    const e = new Error("Error invoking remote method 'tape:setDepthSubscription': Error: Not connected to IB Gateway / TWS");
    expect(ipcErrorMessage(e)).toBe('Not connected to IB Gateway / TWS');
    expect(ipcErrorMessage('plain')).toBe('plain');
  });

  it('shortens historical data errors', () => {
    const e = new Error(
      "Error invoking remote method 'tape:getHistory': IbRequestError: Historical Market Data Service error message:Trading TWS session is connected from a different IP address (IB 162)",
    );
    expect(historyErrorMessage(e)).toBe('Trading TWS session is connected from a different IP address (IB 162)');
  });
});
