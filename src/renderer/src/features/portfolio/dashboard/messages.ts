// Strings of the dashboard: edit controls, the widget catalog and the widgets (design v6).

import { createMessages } from '../../../i18n';
import type { WidgetId } from './layout';

interface CatalogText {
  name: string;
  desc: string;
}

export const useDashboardMessages = createMessages({
  en: {
    // Edit mode
    editLayout: 'Edit layout',
    done: 'Done',
    reset: 'Reset',
    addWidget: 'Add widget',
    addWidgetHint: 'Add or remove any time',
    add: '+ Add',
    remove: 'Remove',
    dragToReorder: 'Drag to reorder',
    /** S / M / L: [label, tooltip]. */
    sizes: [
      ['S', '1 column'],
      ['M', '2 columns'],
      ['L', 'Full row'],
    ] as Array<[string, string]>,
    catalog: {
      alloc: { name: 'Sector allocation', desc: 'Pie by sector, including cash' },
      greeks: { name: 'Portfolio Greeks', desc: 'Delta, Gamma, Theta and Vega across all positions' },
      conc: { name: 'Concentration', desc: 'Stock and options combined per underlying; flags >20%' },
      contrib: { name: 'Today’s P&L by position', desc: 'Positions moving your P&L most today' },
      expiry: { name: 'Option expirations', desc: 'Option positions, soonest first' },
      fills: { name: 'Today’s trades', desc: 'Latest executions' },
      events: { name: 'Earnings & dividends', desc: 'Upcoming earnings and ex-dividend dates for holdings' },
    } as Record<WidgetId, CatalogText>,

    // Greeks
    greeksTitle: 'Portfolio Greeks',
    greeksSub: 'Incl. stock, share-equivalent',
    dollarDelta: 'Dollar delta',
    gammaSub: 'Delta change per $1 move',
    thetaSub: 'Time decay per day ($)',
    vegaSub: 'P&L per 1% IV change ($)',
    greeksPending: (n: number) => `Waiting for IBKR’s model greeks on ${n === 1 ? '1 option' : `${n} options`}`,

    // Concentration
    concTitle: 'Concentration',
    concSub: 'Per underlying, stock + options',
    top3Label: 'Top 3 share of net liq',
    concNote: 'Highlighted: over 20% of net liq',

    // Today's P&L by position
    contribTitle: 'Today’s P&L by position',
    contribSub: 'Largest movers first',
    noDayPnl: 'No P&L for today from IBKR yet',

    // Option expirations
    expiryTitle: 'Option expirations',
    expirySub: 'Soonest first',
    dte: 'DTE',
    expirySubline: (qty: string, value: string) => `Qty ${qty} · Value ${value}`,
    itm: 'ITM',
    otm: 'OTM',
    noOptions: 'No option positions',

    // Today's trades
    fillsTitle: 'Today’s trades',
    fillCount: (n: number) => (n === 1 ? '1 fill' : `${n} fills`),
    all: 'All ›',
    buy: 'Buy',
    sell: 'Sell',

    // Earnings & dividends
    eventsTitle: 'Earnings & dividends',
    eventsSub: 'Holdings only',
    days: 'days',
    earnings: 'Earnings',
    exDividend: 'Ex-dividend',
    eventTime: { bmo: 'Before open', amc: 'After close', dmh: 'During market' } as Record<'bmo' | 'amc' | 'dmh', string>,
    /** An exact release time, New York, in the user's clock format ("8:30 AM"). */
    atEt: (t: string) => `${t} ET`,
    estimated: 'Est.',
    estimatedHint: 'Estimated from IB’s market scanner: not a confirmed date',
    eventsNoteSearching: 'Looking up earnings dates…',
    eventsNoteUnsubscribed: 'Earnings dates need the Wall Street Horizon subscription (not subscribed)',
    eventsNoteUnavailable: 'Earnings dates unavailable',
    noEvents: 'No upcoming events',
    noDividends: 'No upcoming ex-dividend dates',
  },
  zh: {
    editLayout: '编辑布局',
    done: '完成',
    reset: '恢复默认',
    addWidget: '添加组件',
    addWidgetHint: '可随时添加或移除',
    add: '+ 添加',
    remove: '移除',
    dragToReorder: '拖动排序',
    sizes: [
      ['窄', '占 1 列'],
      ['中', '占 2 列'],
      ['宽', '整行'],
    ] as Array<[string, string]>,
    catalog: {
      alloc: { name: '板块分布', desc: '按板块和现金拆分的饼图' },
      greeks: { name: '组合 Greeks', desc: '全部持仓汇总的 Delta、Gamma、Theta、Vega' },
      conc: { name: '持仓集中度', desc: '按标的合并股票和期权，单只超过 20% 标出' },
      contrib: { name: '今日盈亏贡献', desc: '今天影响最大的持仓' },
      expiry: { name: '期权到期', desc: '按剩余天数排序的期权持仓' },
      fills: { name: '今日成交', desc: '最近的成交记录' },
      events: { name: '财报与除息', desc: '持仓标的的近期财报和除息日' },
    } as Record<WidgetId, CatalogText>,

    greeksTitle: '组合 Greeks',
    greeksSub: '含正股，按股数等效',
    dollarDelta: '美元等效',
    gammaSub: '标的每涨 $1 Delta 的变化',
    thetaSub: '每天时间价值变化 ($)',
    vegaSub: 'IV 每变动 1% 的盈亏 ($)',
    greeksPending: (n: number) => `等待 IBKR 计算 ${n} 个期权的 Greeks`,

    concTitle: '持仓集中度',
    concSub: '按标的，股票 + 期权',
    top3Label: '前 3 大合计占净值',
    concNote: '荧光色表示单只超过净值 20%',

    contribTitle: '今日盈亏贡献',
    contribSub: '按影响大小排序',
    noDayPnl: 'IBKR 尚未返回今日盈亏',

    expiryTitle: '期权到期',
    expirySub: '按剩余天数排序',
    dte: '天',
    expirySubline: (qty: string, value: string) => `持仓 ${qty} · 市值 ${value}`,
    itm: '价内',
    otm: '价外',
    noOptions: '没有期权持仓',

    fillsTitle: '今日成交',
    fillCount: (n: number) => `${n} 笔`,
    all: '全部 ›',
    buy: '买入',
    sell: '卖出',

    eventsTitle: '财报与除息',
    eventsSub: '仅持仓标的',
    days: '天',
    earnings: '财报',
    exDividend: '除息',
    eventTime: { bmo: '盘前', amc: '盘后', dmh: '盘中' } as Record<'bmo' | 'amc' | 'dmh', string>,
    atEt: (t: string) => `美东 ${t}`,
    estimated: '预估',
    estimatedHint: '由 IB 市场扫描器推算，并非确认日期',
    eventsNoteSearching: '正在查询财报日期…',
    eventsNoteUnsubscribed: '财报日期需要订阅 Wall Street Horizon（未订阅）',
    eventsNoteUnavailable: '暂时无法获取财报日期',
    noEvents: '暂无近期事件',
    noDividends: '暂无近期除息',
  },
});

export type DashboardMessages = ReturnType<typeof useDashboardMessages>;
