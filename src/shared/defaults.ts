// Defaults for first launch.

import { index, stock } from './contract';
import type { Lang, NotificationKind, Settings, Watchlist } from './types';

export const NOTIFICATION_KINDS: readonly NotificationKind[] = ['fill', 'order', 'price', 'opt', 'conn', 'sys'];

export const DEFAULT_PORTS = { tws: { live: 7496, paper: 7497 }, gateway: { live: 4001, paper: 4002 } } as const;

export function defaultSettings(language: Lang = 'en'): Settings {
  return {
    connection: {
      mode: 'gateway',
      host: '127.0.0.1',
      port: DEFAULT_PORTS.gateway.paper,
      clientId: 7,
      autoConnect: true,
      autoReconnect: true,
      readOnly: false,
    },
    trading: { confirmOrders: true, defaultQty: 100, outsideRthDefault: false },
    appearance: { theme: 'system', language, upColor: 'cn', showAccountId: true },
    features: { depth: false, options: true, flow: true },
    notifications: {
      system: { fill: true, order: true, price: true, opt: true, conn: true, sys: true },
      sound: true,
      dnd: false,
    },
    apiLog: { writeFile: true, keepDays: 7 },
  };
}

export function defaultWatchlists(): Watchlist[] {
  const s = (sym: string, name: string) => ({ contract: stock(sym), name });
  const i = (sym: string, exchange: string, en: string, zh: string) => ({ contract: index(sym, exchange), name: { en, zh } });
  return [
    {
      id: 'main',
      builtin: true,
      name: { en: 'Watchlist', zh: '自选' },
      groups: [
        {
          id: 'g-tech',
          name: { en: 'Tech', zh: '科技' },
          items: [s('AAPL', 'Apple'), s('NVDA', 'NVIDIA'), s('MSFT', 'Microsoft'), s('AMD', 'AMD'), s('META', 'Meta'), s('AMZN', 'Amazon')],
        },
        { id: 'g-auto', name: { en: 'Auto', zh: '汽车' }, items: [s('TSLA', 'Tesla')] },
        { id: 'g-etf', name: 'ETF', items: [s('SPY', 'S&P 500 ETF'), s('QQQ', 'Nasdaq 100 ETF')] },
      ],
    },
    {
      id: 'idx',
      builtin: true,
      name: { en: 'Indices', zh: '指数' },
      groups: [
        {
          id: 'g-us',
          name: { en: 'US', zh: '美股' },
          items: [
            i('SPX', 'CBOE', 'S&P 500', '标普 500'),
            i('NDX', 'NASDAQ', 'Nasdaq 100', '纳指 100'),
            i('INDU', 'CME', 'Dow Jones', '道琼斯'),
            i('RUT', 'RUSSELL', 'Russell 2000', '罗素 2000'),
            i('VIX', 'CBOE', 'Volatility index', '波动率指数'),
          ],
        },
        {
          id: 'g-macro',
          name: { en: 'Macro', zh: '宏观' },
          items: [i('TNX', 'CBOE', '10Y Treasury yield ×10', '10 年美债收益率 ×10'), i('DX', 'NYBOT', 'US Dollar index', '美元指数')],
        },
      ],
    },
    {
      id: 'w-options',
      name: { en: 'Options watch', zh: '期权观察' },
      groups: [{ id: 'g-hiv', name: { en: 'High IV', zh: '高 IV' }, items: [s('TSLA', 'Tesla'), s('NVDA', 'NVIDIA'), s('AMD', 'AMD')] }],
    },
  ];
}
