import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stock } from '@shared/contract';
import type { TimeFormat } from '@shared/timeFormat';
import type { Lang, OrderRequest, WorkingOrder } from '@shared/types';
import {
  CANCEL_ALL_UNCONFIRMED_MESSAGE,
  GATEWAY_UNRESPONSIVE_MESSAGE,
  IB_LINK_LOST_MESSAGE,
  NOT_CONNECTED_MESSAGE,
  ORDER_LIST_CHANGED_MESSAGE,
  ORDER_UNCONFIRMED_MESSAGE,
  SESSION_CHANGED_MESSAGE,
  STALE_ORDER_MESSAGE,
} from '@shared/ipc';
import { confirmCancel, connectionHealthText, explainCancelBlock, orderErrorText, orderLine, sendCancelAll, sendOrder, submitOrder } from './orderActions';
import { usePanels } from '../features/panels/panelStore';
import { isPanelSending, useOrderFeedback } from './orderFeedback';
import { useStore } from './store';

const placeOrder = vi.fn();
const cancelOrder = vi.fn();
const modifyOrder = vi.fn();
const cancelAllOrders = vi.fn();
const refreshOrders = vi.fn(async () => undefined);
(globalThis as unknown as { window: unknown }).window = { tape: { placeOrder, cancelOrder, modifyOrder, cancelAllOrders, refreshOrders } };

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

  it('shows main’s own refusals in the user’s language', () => {
    expect(orderErrorText(ipcError('cancelOrder', STALE_ORDER_MESSAGE))).toBe('This order list is out of date; nothing was sent');
    expect(orderErrorText(ipcError('placeOrder', IB_LINK_LOST_MESSAGE))).toBe(
      'IB Gateway has lost its connection to IBKR (1100): orders cannot reach IBKR until it is restored. Nothing was sent.',
    );
    setUp(4002, 'gateway', 'zh');
    expect(orderErrorText(ipcError('cancelAllOrders', ORDER_LIST_CHANGED_MESSAGE))).toBe('订单列表已变化，请重新确认。未发送任何内容');
    expect(orderErrorText(ipcError('cancelOrder', STALE_ORDER_MESSAGE))).toBe('订单列表已过期，未发送任何内容');
    expect(orderErrorText(ipcError('cancelOrder', SESSION_CHANGED_MESSAGE))).toBe('连接已切换到其他账户或 Gateway，未发送任何内容');
    expect(orderErrorText(ipcError('placeOrder', NOT_CONNECTED_MESSAGE))).toBe('未连接 TWS / IB Gateway');
    expect(orderErrorText(ipcError('modifyOrder', IB_LINK_LOST_MESSAGE))).toBe('IB Gateway 与 IBKR 的连接已中断（1100）：连接恢复前订单无法送达 IBKR。未发送任何内容。');
    setUp(7497, 'gateway', 'zh');
    expect(orderErrorText(ipcError('placeOrder', GATEWAY_UNRESPONSIVE_MESSAGE))).toBe('TWS 无响应：未发送任何内容。若持续无响应，Tape 会重新连接。');
    // IB's own texts stay as IB wrote them.
    expect(orderErrorText(ipcError('placeOrder', 'Order rejected - reason: margin. (201)'))).toBe('Order rejected - reason: margin. (201)');
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
    await expect(sendOrder({ request, rows: [], label: 'Buy', summary: 'Buy 1 AAPL', session: 0 })).resolves.toBe(false);
    expect(useStore.getState().toast).toMatchObject({ tone: 'error', text: `Order failed: ${IB_321} ${GATEWAY_HINT}` });
  });

  it('a rejection right after IB acknowledged the order replaces "Submitted"', async () => {
    vi.useFakeTimers();
    try {
      placeOrder.mockResolvedValue({ orderId: 9, childOrderIds: [], confirmed: true });
      await expect(sendOrder({ request, rows: [], label: 'Buy', summary: 'Buy 200 AAPL', session: 0 })).resolves.toBe(true);
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
      await sendOrder({ request, rows: [], label: 'Buy', summary: 'Buy 200 AAPL', session: 0 });
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
    expect(useStore.getState().confirm!.rows.at(-1)).toEqual({ label: 'Type', value: 'Limit · DAY' });
    // Bound to the session it was opened on: main refuses the cancel on another.
    expect(useStore.getState().confirm!.session).toBe(0);
    await useStore.getState().confirm!.run!();
    expect(cancelOrder).toHaveBeenCalledWith({ orderId: 12, clientId: 7 }, 0);
    expect(useStore.getState().toast).toMatchObject({ tone: 'error', text: `${IB_321} ${GATEWAY_HINT}` });

    confirmCancel({ ...order, tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern', session: 'extended', outsideRth: true });
    expect(useStore.getState().confirm!.rows.at(-1)?.value).toBe('Limit · GTD 10/09 04:00 PM ET · Extended hours');
    // The order's attributes get a row of their own.
    confirmCancel({ ...order, allOrNone: true, algo: { strategy: 'Adaptive', params: { adaptivePriority: 'Normal' } }, oca: { group: 'exit', type: 1 } });
    expect(useStore.getState().confirm!.rows.at(-1)).toEqual({ label: 'Attributes', value: 'AON · Adaptive · OCA exit' });
    setUp(4002, 'gateway', 'zh', '24h');
    confirmCancel({ ...order, tif: 'GTD', goodTillDate: '20261009 16:00:00 US/Eastern' });
    expect(useStore.getState().confirm!.rows.at(-1)?.value).toBe('限价 · GTD 10/09 16:00 ET');
    setUp(4002, 'gateway', 'zh');
    confirmCancel({ ...order, session: 'overnightDay', outsideRth: true });
    expect(useStore.getState().confirm!.rows.at(-1)).toEqual({ label: '类型', value: '限价 · DAY · 夜盘 + 日盘' });
  });
});

describe('orders sent from a floating panel', () => {
  const request: OrderRequest = { contract: stock('AAPL'), action: 'BUY', orderType: 'LMT', quantity: 100, limitPrice: 227.56, tif: 'DAY', outsideRth: false };
  const pending = { request, rows: [], label: 'Buy', summary: 'Buy 100 AAPL', origin: 'ticket' as const, session: 0 };
  const working = (status: WorkingOrder['status'], message?: string): WorkingOrder => ({
    orderId: 31,
    clientId: 7,
    key: '7:31',
    contract: stock('AAPL'),
    action: 'BUY',
    orderType: 'LMT',
    totalQuantity: 100,
    limitPrice: 227.56,
    tif: 'DAY',
    outsideRth: false,
    status,
    filled: 0,
    remaining: 100,
    avgFillPrice: 0,
    createdAt: 0,
    updatedAt: 0,
    message,
  });
  const ticketPanel = () => usePanels.getState().panels.ticket;

  beforeEach(() => {
    setUp(4002);
    useStore.setState((s) => ({ page: 'trade', view: 'chart', connection: { ...s.connection, clientId: 7 }, positions: [], orders: [] }));
    useOrderFeedback.setState({ sent: {} });
    for (const f of [placeOrder, modifyOrder]) f.mockReset();
    usePanels.getState().setFloating('ticket', true);
  });

  it('writes the order line', () => {
    expect(orderLine(pending)).toBe('Buy 100 AAPL · Limit 227.56 · DAY');
    expect(orderLine({ ...pending, request: { ...request, orderType: 'MKT', limitPrice: undefined } })).toBe('Buy 100 AAPL · Market · DAY');
    expect(orderLine({ ...pending, request: { ...request, orderType: 'STP', limitPrice: undefined, stopPrice: 220 } })).toBe('Buy 100 AAPL · Stop 220.00 · DAY');
  });

  it('is “Submitting…” until IB answers, then the strip follows it (no toast) and the panel collapses to its bar', async () => {
    let resolve!: (v: { orderId: number; childOrderIds: number[]; confirmed: boolean }) => void;
    placeOrder.mockReturnValue(new Promise((r) => (resolve = r)));
    const sent = sendOrder(pending);
    expect(useOrderFeedback.getState().sent.ticket).toMatchObject({ phase: 'sending', summary: 'Buy 100 AAPL · Limit 227.56 · DAY', side: 'BUY', quantity: 100 });
    expect(ticketPanel().collapsed).toBe(false);
    resolve({ orderId: 31, childOrderIds: [], confirmed: true });
    await expect(sent).resolves.toBe(true);
    expect(useOrderFeedback.getState().sent.ticket).toMatchObject({ phase: 'sent', orderId: 31, clientId: 7, autoCollapsed: true });
    expect(useOrderFeedback.getState().sent.ticket?.acceptedAt).toEqual(expect.any(Number));
    expect(useStore.getState().toast).toBeNull();
    expect(ticketPanel()).toMatchObject({ floating: true, collapsed: true });
  });

  it('a refusal turns the strip red, keeps the panel expanded and the form as it was', async () => {
    useStore.getState().patchTicket({ qty: 100, limitPrice: 227.56 });
    placeOrder.mockRejectedValue(ipcError('placeOrder', 'Order rejected - reason: margin. (201)'));
    await expect(sendOrder(pending)).resolves.toBe(false);
    expect(useOrderFeedback.getState().sent.ticket).toMatchObject({ phase: 'failed', error: 'Order rejected - reason: margin. (201)' });
    expect(ticketPanel().collapsed).toBe(false);
    expect(useStore.getState().ticket).toMatchObject({ qty: 100, limitPrice: 227.56 });
    expect(useStore.getState().toast).toBeNull();
  });

  it('not connected: the strip says so and the panel stays', async () => {
    useStore.setState((s) => ({ connection: { ...s.connection, status: 'disconnected' } }));
    await expect(sendOrder(pending)).resolves.toBe(false);
    expect(useOrderFeedback.getState().sent.ticket).toMatchObject({ phase: 'failed' });
    expect(ticketPanel().collapsed).toBe(false);
  });

  it('a late rejection turns it red and expands the panel this order collapsed', async () => {
    placeOrder.mockResolvedValue({ orderId: 31, childOrderIds: [], confirmed: true });
    await sendOrder(pending);
    expect(ticketPanel().collapsed).toBe(true);
    useStore.setState({ orders: [working('Inactive', 'No trading permissions (201)')] });
    expect(useOrderFeedback.getState().sent.ticket).toMatchObject({ phase: 'failed', error: 'No trading permissions (201)' });
    expect(ticketPanel().collapsed).toBe(false);
    useStore.setState({ orders: [] });
  });

  it('a modify shows as such, ends modifying and collapses the panel too', async () => {
    modifyOrder.mockResolvedValue({ confirmed: true });
    useStore.getState().patchTicket({ modifyingOrderId: 31 });
    await sendOrder({ ...pending, modifyOrderId: 31 });
    expect(useOrderFeedback.getState().sent.ticket).toMatchObject({ kind: 'modify', phase: 'sent', orderId: 31 });
    expect(useStore.getState().ticket.modifyingOrderId).toBeNull();
    expect(ticketPanel().collapsed).toBe(true);
  });

  it('a panel docked meanwhile is not collapsed (nothing to collapse), and a toast reports the order', async () => {
    let resolve!: (v: { orderId: number; childOrderIds: number[]; confirmed: boolean }) => void;
    placeOrder.mockReturnValue(new Promise((r) => (resolve = r)));
    const sent = sendOrder(pending);
    usePanels.getState().setFloating('ticket', false);
    resolve({ orderId: 31, childOrderIds: [], confirmed: true });
    await sent;
    expect(ticketPanel()).toMatchObject({ floating: false, collapsed: false });
    expect(useOrderFeedback.getState().sent.ticket?.autoCollapsed).toBeUndefined();
    expect(useStore.getState().toast).toMatchObject({ text: 'Submitted: Buy 100 AAPL' });
  });

  it('a second order while the first waits for IB is not sent', async () => {
    let resolve!: (v: { orderId: number; childOrderIds: number[]; confirmed: boolean }) => void;
    placeOrder.mockReturnValue(new Promise((r) => (resolve = r)));
    const first = sendOrder(pending);
    expect(isPanelSending('ticket')).toBe(true);
    expect(isPanelSending(undefined)).toBe(false);
    const seq = useOrderFeedback.getState().sent.ticket?.seq;
    await expect(sendOrder(pending)).resolves.toBe(false);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(useOrderFeedback.getState().sent.ticket).toMatchObject({ seq, phase: 'sending' });
    resolve({ orderId: 31, childOrderIds: [], confirmed: true });
    await expect(first).resolves.toBe(true);
    expect(isPanelSending('ticket')).toBe(false);
    // Once IB has answered, the next order goes out.
    placeOrder.mockResolvedValue({ orderId: 32, childOrderIds: [], confirmed: true });
    await expect(sendOrder(pending)).resolves.toBe(true);
    expect(placeOrder).toHaveBeenCalledTimes(2);
  });

  it('a refusal while the panel is docked back shows a toast as well', async () => {
    let reject!: (e: Error) => void;
    placeOrder.mockReturnValue(new Promise((_, r) => (reject = r)));
    const sent = sendOrder(pending);
    usePanels.getState().setFloating('ticket', false);
    reject(ipcError('placeOrder', 'Order rejected - reason: margin. (201)'));
    await expect(sent).resolves.toBe(false);
    expect(useStore.getState().toast).toMatchObject({ tone: 'error', text: 'Order failed: Order rejected - reason: margin. (201)' });
    expect(useOrderFeedback.getState().sent.ticket).toMatchObject({ phase: 'failed' });
  });

  it('a late rejection after leaving the page shows a toast', async () => {
    placeOrder.mockResolvedValue({ orderId: 31, childOrderIds: [], confirmed: true });
    await sendOrder(pending);
    expect(useStore.getState().toast).toBeNull();
    useStore.setState({ page: 'acct' });
    useStore.setState({ orders: [working('Inactive', 'No trading permissions (201)')] });
    expect(useStore.getState().toast).toMatchObject({ tone: 'error', text: 'Order failed: No trading permissions (201)' });
    expect(useOrderFeedback.getState().sent.ticket).toMatchObject({ phase: 'failed' });
    useStore.setState({ orders: [] });
  });

  it('an order from the docked ticket keeps its toasts', async () => {
    placeOrder.mockResolvedValue({ orderId: 31, childOrderIds: [], confirmed: true });
    await sendOrder({ ...pending, origin: undefined });
    expect(useStore.getState().toast?.text).toContain('Buy 100 AAPL');
    expect(useOrderFeedback.getState().sent.ticket).toBeUndefined();
    expect(ticketPanel().collapsed).toBe(false);
  });

  it('notes the position before the order (the fill line)', async () => {
    placeOrder.mockResolvedValue({ orderId: 31, childOrderIds: [], confirmed: true });
    useStore.setState({ positions: [{ key: 'p', contract: stock('AAPL'), quantity: 200, avgPrice: 200 } as never] });
    await sendOrder(pending);
    expect(useOrderFeedback.getState().sent.ticket?.positionBefore).toBe(200);
  });
});

describe('orders while IB Gateway cannot carry them', () => {
  const request: OrderRequest = { contract: stock('AAPL'), action: 'BUY', orderType: 'LMT', quantity: 100, limitPrice: 227.56, tif: 'DAY', outsideRth: false };
  const docked = { request, rows: [], label: 'Buy', summary: 'Buy 100 AAPL', session: 0 };
  const health = (patch: { ibLinkLost?: boolean; unresponsive?: boolean }) => useStore.setState((s) => ({ connection: { ...s.connection, ibLinkLost: undefined, unresponsive: undefined, ...patch } }));

  beforeEach(() => {
    setUp(4002);
    useOrderFeedback.setState({ sent: {} });
    for (const f of [placeOrder, modifyOrder, cancelOrder]) f.mockReset();
  });
  afterEach(() => health({}));

  it('sends no order or modify after IB Gateway lost IB (1100) or while it does not answer', async () => {
    health({ ibLinkLost: true });
    await expect(sendOrder(docked)).resolves.toBe(false);
    expect(useStore.getState().toast).toMatchObject({
      tone: 'error',
      text: 'Order failed: IB Gateway has lost its connection to IBKR (1100): orders cannot reach IBKR until it is restored. Nothing was sent.',
    });
    await expect(sendOrder({ ...docked, modifyOrderId: 31 })).resolves.toBe(false);
    health({ unresponsive: true });
    await expect(sendOrder(docked)).resolves.toBe(false);
    expect(useStore.getState().toast?.text).toBe('Order failed: IB Gateway is not responding: nothing was sent. Tape reconnects if it stays silent.');
    expect(placeOrder).not.toHaveBeenCalled();
    expect(modifyOrder).not.toHaveBeenCalled();
    health({});
    placeOrder.mockResolvedValue({ orderId: 31, childOrderIds: [], confirmed: true });
    await expect(sendOrder(docked)).resolves.toBe(true);
  });

  it('still offers a cancel, warning that it may not reach IBKR', () => {
    health({ ibLinkLost: true });
    const o = { orderId: 9, clientId: 7, key: '7:9', contract: stock('AAPL'), action: 'BUY', orderType: 'LMT', totalQuantity: 1, limitPrice: 1, tif: 'DAY', outsideRth: false, status: 'Submitted', filled: 0, remaining: 1, avgFillPrice: 0, createdAt: 0, updatedAt: 0 } as WorkingOrder;
    confirmCancel(o);
    expect(useStore.getState().confirm?.warnings).toEqual(['IB Gateway has lost its connection to IBKR (1100): the cancel may not reach IBKR until it is restored.']);
    expect(useStore.getState().confirm?.run).toBeDefined();
    useStore.setState({ confirm: null });
  });

  it('names the state for the top bar in the user’s language', () => {
    health({ unresponsive: true });
    expect(connectionHealthText('chip')).toBe('IB Gateway not responding');
    setUp(7497, 'tws', 'zh');
    health({ ibLinkLost: true });
    expect(connectionHealthText('chip')).toBe('与 IBKR 断开 (1100)');
    // Not connected: nothing to say.
    useStore.setState((s) => ({ connection: { ...s.connection, status: 'disconnected' } }));
    expect(connectionHealthText('chip')).toBeUndefined();
  });
});

describe('orders bound to the connection session', () => {
  const request: OrderRequest = { contract: stock('AAPL'), action: 'BUY', orderType: 'LMT', quantity: 1, limitPrice: 1, tif: 'DAY', outsideRth: false };
  const setSession = (session: number) => useStore.setState((s) => ({ connection: { ...s.connection, session } }));
  const working = (status: WorkingOrder['status']): WorkingOrder => ({
    orderId: 9,
    clientId: 7,
    key: '7:9',
    contract: stock('AAPL'),
    action: 'BUY',
    orderType: 'LMT',
    totalQuantity: 1,
    limitPrice: 1,
    tif: 'DAY',
    outsideRth: false,
    status,
    filled: 0,
    remaining: 1,
    avgFillPrice: 0,
    createdAt: 0,
    updatedAt: 0,
  });

  beforeEach(() => {
    setUp(4002);
    useStore.setState((s) => ({ connection: { ...s.connection, clientId: 7 }, orders: [] }));
    setSession(3);
    for (const f of [placeOrder, modifyOrder, cancelOrder]) f.mockReset();
  });
  afterEach(() => setSession(0));

  it('binds an order to the session it is submitted on and sends that session with it', async () => {
    placeOrder.mockResolvedValue({ orderId: 9, childOrderIds: [], confirmed: true });
    modifyOrder.mockResolvedValue({ confirmed: true });
    submitOrder({ request, rows: [], label: 'Buy', summary: 'Buy 1 AAPL' });
    // With a review it waits for the confirmation, bound to session 3.
    const review = useStore.getState().pendingOrder;
    if (review) {
      expect(review.session).toBe(3);
      await sendOrder(review);
    }
    expect(placeOrder).toHaveBeenCalledWith(request, 3);
    await sendOrder({ request, rows: [], label: 'Buy', summary: 'Buy 1 AAPL', modifyOrderId: 40, session: 3 });
    expect(modifyOrder).toHaveBeenCalledWith(40, request, 3);
  });

  it('refuses an order reviewed on another session, without asking main', async () => {
    await expect(sendOrder({ request, rows: [], label: 'Buy', summary: 'Buy 1 AAPL', session: 2 })).resolves.toBe(false);
    await expect(sendOrder({ request, rows: [], label: 'Buy', summary: 'Buy 1 AAPL', modifyOrderId: 40, session: 2 })).resolves.toBe(false);
    expect(placeOrder).not.toHaveBeenCalled();
    expect(modifyOrder).not.toHaveBeenCalled();
    expect(useStore.getState().toast).toMatchObject({ tone: 'error', text: 'The connection switched to another account; the order was not sent' });
  });

  it('sends a cancel with the session its dialog was opened on', async () => {
    cancelOrder.mockResolvedValue({ status: 'Cancelled' });
    confirmCancel(working('Submitted'));
    expect(useStore.getState().confirm?.session).toBe(3);
    await useStore.getState().confirm!.run!();
    expect(cancelOrder).toHaveBeenCalledWith({ orderId: 9, clientId: 7 }, 3);
  });

  it('stops watching for a late rejection once the session changes (the id names another account’s order)', async () => {
    vi.useFakeTimers();
    try {
      placeOrder.mockResolvedValue({ orderId: 9, childOrderIds: [], confirmed: true });
      await sendOrder({ request, rows: [], label: 'Buy', summary: 'Buy 1 AAPL', session: 3 });
      expect(useStore.getState().toast).toMatchObject({ text: 'Submitted: Buy 1 AAPL' });
      setSession(4);
      useStore.setState({ orders: [working('Inactive')] });
      expect(useStore.getState().toast).toMatchObject({ text: 'Submitted: Buy 1 AAPL' });
    } finally {
      vi.useRealTimers();
      useStore.setState({ orders: [] });
    }
  });
});

describe('cancelling an order', () => {
  const live = { status: 'connected' as const, port: 4001, clientId: 7, session: 5, accounts: ['U18630011'], account: 'U18630011', isPaper: false };
  const order = (patch: Partial<WorkingOrder> = {}): WorkingOrder => ({
    orderId: 3,
    permId: 186573947,
    clientId: 7,
    account: 'U18630011',
    key: 'STK:SPCX',
    contract: stock('SPCX'),
    action: 'BUY',
    orderType: 'LMT',
    totalQuantity: 100,
    limitPrice: 158.11,
    tif: 'GTC',
    outsideRth: false,
    status: 'Submitted',
    filled: 0,
    remaining: 100,
    avgFillPrice: 0,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  });
  const confirm = () => useStore.getState().confirm!;
  const row = (label: string) => confirm().rows.find((r) => r.label === label);

  beforeEach(() => {
    setUp(4001);
    useStore.setState((s) => ({ connection: { ...s.connection, ...live, readOnlyApi: undefined }, orders: [], pendingCancels: [], cancelAll: null }));
    for (const f of [cancelOrder, cancelAllOrders]) f.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    useStore.setState((s) => ({ connection: { ...s.connection, session: 0, accounts: [], account: undefined, readOnlyApi: undefined }, orders: [], pendingCancels: [], settings: { ...s.settings, appearance: { ...s.settings.appearance, showAccountId: true } } }));
  });

  it('names the order and its account (live in red, the id hidden on request) and what has filled', () => {
    confirmCancel(order({ filled: 30, remaining: 70 }));
    expect(confirm().title).toBe('Cancel order #3');
    expect(confirm().rows[0]).toEqual({ label: 'Account', value: 'LIVE · U18630011', color: 'var(--r)' });
    expect(row('Filled')).toEqual({ label: 'Filled', value: '30 / 100 · 70 remaining' });
    useStore.setState((s) => ({ settings: { ...s.settings, appearance: { ...s.settings.appearance, showAccountId: false } } }));
    confirmCancel(order());
    expect(confirm().rows[0]).toEqual({ label: 'Account', value: 'LIVE', color: 'var(--r)' });
    expect(row('Filled')).toBeUndefined();
    useStore.setState((s) => ({ connection: { ...s.connection, accounts: ['DUP899854'], account: 'DUP899854', isPaper: true } }));
    confirmCancel(order({ account: 'DUP899854' }));
    expect(confirm().rows[0]).toEqual({ label: 'Account', value: 'PAPER' });
    setUp(4002, 'gateway', 'zh');
    confirmCancel(order({ account: 'DUP899854' }));
    expect(confirm().title).toBe('撤单 #3');
    expect(confirm().rows[0]).toEqual({ label: '账户', value: '模拟' });
  });

  it('says what cancelling a bracket order does', () => {
    const entry = order({ orderId: 50, permId: 9050 });
    const tp = order({ orderId: 51, permId: 9051, parentId: 50, action: 'SELL', limitPrice: 233 });
    const sl = order({ orderId: 52, permId: 9052, parentId: 50, action: 'SELL', orderType: 'STP', limitPrice: undefined, auxPrice: 222 });
    useStore.setState({ orders: [entry, tp, sl] });
    confirmCancel(entry);
    expect(confirm().rows.slice(-2)).toEqual([
      { label: 'Take profit', value: 'Sell 100 @ 233.00' },
      { label: 'Stop loss', value: 'Sell 100 STP 222.00' },
    ]);
    expect(confirm().note).toBe('Its take-profit and stop-loss orders are cancelled with it.');
    confirmCancel(tp);
    expect(confirm().rows.at(-1)).toEqual({ label: 'Bracket', value: 'Exit of order #50', prose: true });
    expect(confirm().note).toBe('Only this order is cancelled; the rest of the bracket stays working.');
    expect(confirm().warnings).toBeUndefined();
    // The entry still works: once it fills, nothing protects the position.
    confirmCancel(sl);
    expect(confirm().warnings).toEqual(['Order #50 stays working without this stop-loss: once it fills, the position has no stop protection.']);
    // The entry has filled: the stop-loss is the position's protection.
    useStore.setState({ orders: [{ ...entry, status: 'Filled', filled: 100, remaining: 0 }, tp, sl] });
    confirmCancel(sl);
    expect(confirm().warnings).toEqual(['This is the position’s stop-loss: once it is cancelled, the position has no stop protection.']);
    // The entry is not listed (it filled while Tape could not hear it): the stop-loss protects the position all the same.
    useStore.setState({ orders: [tp, sl] });
    confirmCancel(sl);
    expect(confirm().rows.at(-1)).toEqual({ label: 'Bracket', value: 'Exit of order #50', prose: true });
    expect(confirm().warnings).toEqual(['This is the position’s stop-loss: once it is cancelled, the position has no stop protection.']);
    confirmCancel(tp);
    expect(confirm().note).toBe('Only this order is cancelled; the rest of the bracket stays working.');
  });

  it('warns while IB refuses requests in Read-Only API mode', () => {
    useStore.setState((s) => ({ connection: { ...s.connection, readOnlyApi: true } }));
    confirmCancel(order());
    expect(confirm().warnings).toEqual([
      'Read-Only API is on in IB Gateway: IBKR refuses orders and cancels. Turn it off in IB Gateway › Configure › Settings › API › Settings.',
    ]);
  });

  it('shows “Cancelling…” at once, says when IB has cancelled it, and sends a second click nothing', async () => {
    let answer!: (r: { status: string }) => void;
    cancelOrder.mockReturnValue(new Promise((r) => (answer = r)));
    const o = order();
    confirmCancel(o);
    const sent = confirm().run!();
    expect(cancelOrder).toHaveBeenCalledWith({ orderId: 3, clientId: 7, permId: 186573947, account: 'U18630011' }, 5);
    expect(useStore.getState().pendingCancels).toEqual(['p:186573947']);
    useStore.setState({ confirm: null });
    confirmCancel(o);
    expect(useStore.getState().confirm).toBeNull();
    answer({ status: 'Cancelled' });
    await sent;
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(useStore.getState().toast).toMatchObject({ tone: 'info', text: 'Order #3 cancelled' });
    expect(useStore.getState().pendingCancels).toEqual([]);
  });

  it('after “Cancel sent” confirms from the order list, or warns after 10 s', async () => {
    vi.useFakeTimers();
    const o = order();
    useStore.setState({ orders: [o] });
    cancelOrder.mockResolvedValue({ status: 'sent' });
    confirmCancel(o);
    await confirm().run!();
    expect(useStore.getState().toast).toMatchObject({ tone: 'info', text: 'Cancel of order #3 sent, waiting for IBKR' });
    expect(useStore.getState().pendingCancels).toEqual(['p:186573947']);
    useStore.setState({ orders: [{ ...o, status: 'Cancelled' }] });
    expect(useStore.getState().toast).toMatchObject({ text: 'Order #3 cancelled' });
    expect(useStore.getState().pendingCancels).toEqual([]);

    useStore.setState({ orders: [o] });
    cancelOrder.mockResolvedValue({ status: 'PendingCancel' });
    confirmCancel(o);
    await confirm().run!();
    useStore.setState({ orders: [{ ...o, status: 'PendingCancel' }] });
    vi.advanceTimersByTime(9_900);
    expect(useStore.getState().pendingCancels).toEqual(['p:186573947']);
    vi.advanceTimersByTime(100);
    expect(useStore.getState().toast).toMatchObject({ tone: 'warning', text: 'IBKR has not confirmed the cancel of order #3 yet; check it in Orders' });
    expect(useStore.getState().pendingCancels).toEqual([]);
  });

  it('explains why an order of another app cannot be cancelled, and offers Cancel all', async () => {
    const mobile = order({ orderId: 0, clientId: 0, permId: 2124812801 });
    explainCancelBlock(mobile, 'manual');
    expect(confirm()).toMatchObject({ title: 'Why Tape can’t cancel this order', label: 'Cancel all orders…', session: 5 });
    expect(confirm().rows.slice(0, 2)).toEqual([
      { label: 'Placed in', value: 'Other app', prose: true },
      { label: 'Account', value: 'LIVE · U18630011', color: 'var(--r)' },
    ]);
    expect(confirm().note).toContain('Cancel it in IBKR Mobile, Client Portal or TWS');
    refreshOrders.mockClear();
    await confirm().run!();
    expect(useStore.getState().cancelAll).toEqual({ session: 5 });
    // The dialog lists IB's current orders: other apps' orders get no updates between IB's lists.
    expect(refreshOrders).toHaveBeenCalledTimes(1);
    explainCancelBlock(order({ clientId: 12 }), 'otherClient');
    expect(confirm().rows[0]).toEqual({ label: 'Placed in', value: 'Client 12', prose: true });
    // Another account's order: nothing Tape could do here, only a button that closes.
    explainCancelBlock(order({ account: 'U9' }), 'otherAccount');
    expect(confirm()).toMatchObject({ label: 'Close', note: 'It belongs to account U9, which this login does not manage. Connect to that account to cancel it.' });
    expect(confirm().run).toBeUndefined();
  });

  it('Cancel all closes its dialog and reports how many ended, and how', async () => {
    const expect3 = { account: 'U18630011', permIds: [1620569957, 2124812801, 780760062], session: 5 };
    useStore.setState({ cancelAll: { session: 5 } });
    cancelAllOrders.mockResolvedValue({ requested: 3, cancelled: 2, filled: 0, unknown: 0, stillWorking: 1 });
    await sendCancelAll(expect3);
    expect(cancelAllOrders).toHaveBeenCalledWith(expect3);
    expect(useStore.getState().cancelAll).toBeNull();
    expect(useStore.getState().toast).toMatchObject({ tone: 'warning', text: 'Cancel all: 2 of 3 cancelled, 1 still working; check Orders' });
    cancelAllOrders.mockResolvedValue({ requested: 3, cancelled: 3, filled: 0, unknown: 0, stillWorking: 0 });
    await sendCancelAll(expect3);
    expect(useStore.getState().toast).toMatchObject({ tone: 'info', text: 'Cancel all: 3 of 3 cancelled' });
    // An order that filled, or one IB no longer lists without saying how, is never called cancelled.
    cancelAllOrders.mockResolvedValue({ requested: 3, cancelled: 1, filled: 1, unknown: 1, stillWorking: 0 });
    await sendCancelAll(expect3);
    expect(useStore.getState().toast).toMatchObject({ tone: 'warning', text: 'Cancel all: 1 of 3 cancelled, 1 filled, 1 no longer listed, outcome unknown; check Orders and Trades' });
    setUp(4001, 'gateway', 'zh');
    await sendCancelAll(expect3);
    expect(useStore.getState().toast).toMatchObject({ tone: 'warning', text: '全部撤单：3 笔中已撤销 1 笔，1 笔已成交，1 笔已不在挂单中、结果未知，请在订单和成交中查看' });
    setUp(4001);
    cancelAllOrders.mockRejectedValue(ipcError('cancelAllOrders', IB_321));
    await sendCancelAll(expect3);
    expect(useStore.getState().toast).toMatchObject({ tone: 'error', text: `${IB_321} Turn off “Read-Only API” in IB Gateway › Configure › Settings › API › Settings to trade.` });
    // The connection closed after the global cancel went out: IB may have cancelled them.
    setUp(4001, 'gateway', 'zh');
    cancelAllOrders.mockRejectedValue(ipcError('cancelAllOrders', CANCEL_ALL_UNCONFIRMED_MESSAGE));
    await sendCancelAll(expect3);
    expect(useStore.getState().toast).toMatchObject({ tone: 'warning', text: '全部撤单指令发出后连接已关闭：IBKR 可能已撤销这些订单。重新连接后请在订单中查看。' });
  });
});

describe('orders IB has not confirmed', () => {
  const request: OrderRequest = { contract: stock('AAPL'), action: 'BUY', orderType: 'LMT', quantity: 1, limitPrice: 1, tif: 'DAY', outsideRth: false };

  beforeEach(() => {
    setUp(4002);
    for (const f of [placeOrder, modifyOrder]) f.mockReset();
    useOrderFeedback.setState({ sent: {} });
  });

  it('a sent order or modify IB has not answered is a warning, not “Submitted”', async () => {
    placeOrder.mockResolvedValue({ orderId: 9, childOrderIds: [], confirmed: false });
    await expect(sendOrder({ request, rows: [], label: 'Buy', summary: 'Buy 1 AAPL', session: 0 })).resolves.toBe(true);
    expect(useStore.getState().toast).toMatchObject({ tone: 'warning', text: 'Sent #9: IBKR has not confirmed it yet; check Orders' });
    modifyOrder.mockResolvedValue({ confirmed: false });
    await sendOrder({ request, rows: [], label: 'Buy', summary: 'Buy 1 AAPL', modifyOrderId: 40, session: 0 });
    expect(useStore.getState().toast).toMatchObject({ tone: 'warning', text: 'Modify of #40 sent: IBKR has not confirmed it yet; check Orders' });
  });

  it('an order the closing connection left unconfirmed is never “failed”, and its panel does not offer to resubmit it', async () => {
    usePanels.getState().setFloating('ticket', true);
    useStore.setState({ page: 'trade', view: 'chart' });
    placeOrder.mockRejectedValue(ipcError('placeOrder', ORDER_UNCONFIRMED_MESSAGE));
    await expect(sendOrder({ request, rows: [], label: 'Buy', summary: 'Buy 1 AAPL', origin: 'ticket', session: 0 })).resolves.toBe(false);
    expect(useOrderFeedback.getState().sent.ticket).toMatchObject({ phase: 'unconfirmed', error: expect.stringContaining('IBKR may have it') });
    usePanels.getState().setFloating('ticket', false);
    await sendOrder({ request, rows: [], label: 'Buy', summary: 'Buy 1 AAPL', session: 0 });
    expect(useStore.getState().toast).toMatchObject({ tone: 'warning', text: expect.stringContaining('Check Orders after reconnecting before sending it again') });
  });
});
