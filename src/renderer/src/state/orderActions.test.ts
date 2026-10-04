import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';
import type { TimeFormat } from '@shared/timeFormat';
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
function setUp(port: number, mode: 'tws' | 'gateway' = 'gateway', language: Lang = 'en', timeFormat: TimeFormat = '12h') {
  useStore.setState((s) => ({
    toast: null,
    confirm: null,
    pendingOrder: null,
    connection: { ...s.connection, status: 'connected', port },
    settings: { ...s.settings, connection: { ...s.settings.connection, mode, port }, appearance: { ...s.settings.appearance, language, timeFormat } },
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

  it('says where to allow directly routed (overnight-only) orders', () => {
    const ib10329 = 'This order will be directly routed to OVERNIGHT. Restriction is specified in Precautionary Settings of Global Configuration/API. (10329)';
    const hint = (path: string) =>
      `Overnight-only orders go directly to IBKR's OVERNIGHT venue: turn on “Bypass Redirect Order warning for Stock API orders” in ${path} to send them.`;
    expect(orderErrorText(ipcError('placeOrder', ib10329))).toBe(`${ib10329} ${hint('IB\u00a0Gateway › Configure › Settings › API › Precautions')}`);
    setUp(7497);
    expect(orderErrorText(ipcError('placeOrder', ib10329))).toBe(`${ib10329} ${hint('TWS › Global\u00a0Configuration › API › Precautions')}`);
    setUp(4002, 'gateway', 'zh');
    expect(orderErrorText(ipcError('placeOrder', ib10329))).toContain('IB\u00a0Gateway › Configure › Settings › API › Precautions 中勾选');
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

  it('a rejection right after IB acknowledged the order replaces "Submitted"', async () => {
    vi.useFakeTimers();
    try {
      placeOrder.mockResolvedValue({ orderId: 9, childOrderIds: [] });
      await expect(sendOrder({ request, rows: [], label: 'Buy', summary: 'Buy 200 AAPL' })).resolves.toBe(true);
      expect(useStore.getState().toast).toMatchObject({ text: 'Submitted: Buy 200 AAPL' });
      const order = (status: WorkingOrder['status'], message?: string): WorkingOrder => ({
        orderId: 9,
        clientId: 7,
        key: '7:9',
        contract: stock('AAPL'),
        action: 'BUY',
        orderType: 'LMT',
        totalQuantity: 200,
        limitPrice: 1,
        tif: 'DAY',
        outsideRth: false,
        status,
        filled: 0,
        remaining: 200,
        avgFillPrice: 0,
        createdAt: 0,
        updatedAt: 0,
        message,
      });
      useStore.setState({ orders: [order('PreSubmitted')] });
      expect(useStore.getState().toast).toMatchObject({ text: 'Submitted: Buy 200 AAPL' });
      // As IB answered an iceberg order on the paper account, 0.55 s after PreSubmitted.
      useStore.setState({ orders: [order('Inactive', 'Order rejected - reason:Display size should be a multiple of lot size.')] });
      expect(useStore.getState().toast).toMatchObject({ tone: 'error', text: 'Order failed: Order rejected - reason:Display size should be a multiple of lot size.' });

      // Later rejections are left to the notification.
      await sendOrder({ request, rows: [], label: 'Buy', summary: 'Buy 200 AAPL' });
      useStore.setState({ orders: [] });
      vi.advanceTimersByTime(5_000);
      useStore.setState({ orders: [order('Inactive')] });
      expect(useStore.getState().toast).toMatchObject({ text: 'Submitted: Buy 200 AAPL' });
    } finally {
      vi.useRealTimers();
      useStore.setState({ orders: [] });
    }
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
    expect(useStore.getState().confirm!.rows.at(-1)).toEqual({ label: 'Type', value: 'LMT · DAY' });
    await useStore.getState().confirm!.run();
    expect(cancelOrder).toHaveBeenCalledWith(12);
    expect(useStore.getState().toast).toMatchObject({ tone: 'error', text: `${IB_321} ${GATEWAY_HINT}` });

    confirmCancel({ ...order, tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern', session: 'extended', outsideRth: true });
    expect(useStore.getState().confirm!.rows.at(-1)?.value).toBe('LMT · GTD 10/09 4:00 PM ET · Extended hours');
    setUp(4002, 'gateway', 'zh', '24h');
    confirmCancel({ ...order, tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern' });
    expect(useStore.getState().confirm!.rows.at(-1)?.value).toBe('LMT · GTD 10/09 16:00 ET');
    setUp(4002, 'gateway', 'zh');
    confirmCancel({ ...order, session: 'overnightDay', outsideRth: true });
    expect(useStore.getState().confirm!.rows.at(-1)).toEqual({ label: '类型', value: 'LMT · DAY · 夜盘 + 日盘' });
  });
});
