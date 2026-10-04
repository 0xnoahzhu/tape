import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';
import type { Lang, OrderRequest, WorkingOrder } from '@shared/types';
import { confirmCancel, orderErrorText, sendOrder } from './orderActions';
import { useStore } from './store';

const placeOrder = vi.fn();
const cancelOrder = vi.fn();
(globalThis as unknown as { window: unknown }).window = { tape: { placeOrder, cancelOrder } };

/** IB's Read-Only API rejection as the renderer receives it from a failed IPC call. */
const IB_321 = 'The API interface is currently in Read-Only mode. (321)';
const ipcError = (method: string, message: string) => new Error(`Error invoking remote method 'tape:${method}': Error: ${message}`);

const GATEWAY_HINT = 'Turn off “Read-Only API” in IB Gateway › Configure › Settings › API › Settings to trade.';
const TWS_HINT = 'Turn off “Read-Only API” in TWS › Global Configuration › API › Settings to trade.';

/** The connected port, the configured mode and the UI language. */
function setUp(port: number, mode: 'tws' | 'gateway' = 'gateway', language: Lang = 'en') {
  useStore.setState((s) => ({
    toast: null,
    confirm: null,
    pendingOrder: null,
    connection: { ...s.connection, status: 'connected', port },
    settings: { ...s.settings, connection: { ...s.settings.connection, mode, port }, appearance: { ...s.settings.appearance, language } },
  }));
}

describe('orderErrorText', () => {
  beforeEach(() => setUp(4002));

  it('adds where to turn off Read-Only API in IB Gateway', () => {
    expect(orderErrorText(ipcError('placeOrder', IB_321))).toBe(`${IB_321} ${GATEWAY_HINT}`);
  });

  it('names the TWS path when connected to a TWS port', () => {
    setUp(7497, 'gateway');
    expect(orderErrorText(ipcError('placeOrder', IB_321))).toBe(`${IB_321} ${TWS_HINT}`);
    setUp(7496, 'gateway');
    expect(orderErrorText(ipcError('modifyOrder', IB_321))).toBe(`${IB_321} ${TWS_HINT}`);
  });

  it('follows the configured mode on other ports', () => {
    setUp(5000, 'tws');
    expect(orderErrorText(new Error(IB_321))).toBe(`${IB_321} ${TWS_HINT}`);
    setUp(5000, 'gateway');
    expect(orderErrorText(new Error(IB_321))).toBe(`${IB_321} ${GATEWAY_HINT}`);
  });

  it('speaks Chinese when the UI does', () => {
    setUp(4002, 'gateway', 'zh');
    expect(orderErrorText(ipcError('placeOrder', IB_321))).toBe(
      `${IB_321} 如需交易，请在 IB Gateway › Configure › Settings › API › Settings 中关闭 “Read-Only API”。`,
    );
  });

  it('matches IB’s shorter wording too', () => {
    expect(orderErrorText(new Error('Read-Only mode. (321)'))).toBe(`Read-Only mode. (321) ${GATEWAY_HINT}`);
  });

  it('leaves other errors as they are, without the IPC wrapper', () => {
    // 321 is also IB's code for other invalid requests.
    const missingExchange = 'Error validating request: missing order exchange. (321)';
    expect(orderErrorText(ipcError('placeOrder', missingExchange))).toBe(missingExchange);
    // Read-only wording without IB's code is not IB's rejection.
    expect(orderErrorText(new Error('Read-only mode is on'))).toBe('Read-only mode is on');
    expect(orderErrorText(ipcError('placeOrder', 'Order rejected - reason: margin. (201)'))).toBe('Order rejected - reason: margin. (201)');
    expect(orderErrorText('plain text')).toBe('plain text');
  });
});

describe('order toasts', () => {
  const request: OrderRequest = { contract: stock('AAPL'), action: 'BUY', orderType: 'LMT', quantity: 1, limitPrice: 1, tif: 'DAY', outsideRth: false };

  beforeEach(() => {
    setUp(4002);
    placeOrder.mockReset();
    cancelOrder.mockReset();
  });

  it('a rejected order says where to turn off Read-Only API', async () => {
    placeOrder.mockRejectedValue(ipcError('placeOrder', IB_321));
    await expect(sendOrder({ request, rows: [], label: 'Buy', summary: 'Buy 1 AAPL' })).resolves.toBe(false);
    expect(useStore.getState().toast).toMatchObject({ tone: 'error', text: `Order failed: ${IB_321} ${GATEWAY_HINT}` });
  });

  it('a rejected cancel does too', async () => {
    cancelOrder.mockRejectedValue(ipcError('cancelOrder', IB_321));
    const order: WorkingOrder = {
      orderId: 12,
      clientId: 7,
      key: '7:12',
      contract: stock('AAPL'),
      action: 'BUY',
      orderType: 'LMT',
      totalQuantity: 1,
      limitPrice: 1,
      tif: 'DAY',
      outsideRth: false,
      status: 'Submitted',
      filled: 0,
      remaining: 1,
      avgFillPrice: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    confirmCancel(order);
    await useStore.getState().confirm!.run();
    expect(cancelOrder).toHaveBeenCalledWith(12);
    expect(useStore.getState().toast).toMatchObject({ tone: 'error', text: `${IB_321} ${GATEWAY_HINT}` });
  });
});
