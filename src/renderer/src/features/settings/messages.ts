// Strings of the Settings page (English from the design's EN map, Chinese from its script).

import { compact, f0 } from '@shared/format';
import type { Clock } from '@shared/timeFormat';
import { createMessages } from '../../i18n';
import type { BiometricKind, LockBiometrics, MarketCheckStatus } from '@shared/types';
import type { ExchangePair, Hint, MarketRow, RowNote, RowTip, ShortcutId } from './logic';

const BIO: Record<BiometricKind, string> = { touchId: 'Touch ID', windowsHello: 'Windows Hello' };

type Pair = { l: string; d: string };
type Age = { unit: 'now' | 'min' | 'h'; n: number } | null;

const en = {
  nav: {
    view: 'General',
    conn: 'Connection',
    data: 'Market Data',
    trade: 'Trade',
    notif: 'Notifications',
    sec: 'Privacy & Security',
    keys: 'Shortcuts',
    log: 'API Log',
  },

  // Connection
  connDesc: 'Connect through the TWS or IB Gateway API port. In TWS, turn on “Enable ActiveX and Socket Clients” first.',
  host: 'Host',
  port: 'Port',
  clientId: 'Client ID',
  hostInvalid: 'Enter a host name or IP address',
  portInvalid: 'Port must be 1–65535',
  cidInvalid: 'Whole number, 0–999,999,999',
  cidHelp:
    'Each program connected to the same TWS / IB Gateway (up to 32 at once) needs its own Client ID: IB refuses a second connection with an ID that is already in use (error 326). Orders belong to the Client ID that placed them; Tape lists the orders of every client but can modify or cancel only its own. With ID 0, orders you enter in TWS while Tape is connected also count as Tape’s own.',
  advanced: 'Advanced: Client ID',
  expand: 'Expand ▾',
  collapse: 'Collapse ▴',
  connect: 'Connect',
  disconnect: 'Disconnect',
  stop: 'Stop',
  connectedTo: (app: string, addr: string) => `Connected ${app} ${addr}`,
  paperAccount: 'paper account',
  liveAccount: 'live account',
  serverVersion: (v: number) => `server v${v}`,
  connecting: (addr: string) => `Connecting to ${addr}…`,
  reconnecting: (n: number, max: number) => `Reconnecting · attempt ${n} of ${max}`,
  notConnectedHelp: 'Not connected. Make sure TWS is running with the API port open.',
  notConnected: 'Not connected',
  farms: 'Data farms',
  viewAll: 'Open full API log ›',
  noMessages: 'No API messages yet',
  autoReconnect: 'Auto-reconnect',
  autoReconnectD: 'Retry every 5 s, up to 10 times',
  disconnectNote: 'Market data and order updates stop. Open orders stay active on IBKR servers.',
  disconnectLabel: 'Disconnect',
  reconnectTitle: 'Reconnect with new settings',
  reconnectNote: 'The current session closes and Tape connects again with these settings. Market data and order updates stop until it is back; open orders stay active on IBKR servers.',
  reconnectLabel: 'Reconnect',
  connectFailed: (msg: string) => `Connection failed: ${msg}`,

  // Market data
  dataDesc: 'Tape picks the best data IB offers for each market on its own: live where you’re subscribed, 15–20 min delayed elsewhere.',
  checkNow: 'Check now',
  checkNowTip: 'Tests every market again, Level 2 included. Takes up to 20 s.',
  checking: 'Checking…',
  /** "Checked 2 min ago" (`at`: the date and time, for older results). */
  checkedAgo: (age: Age, at: string) =>
    !age ? `Checked ${at}` : age.unit === 'now' ? 'Checked just now' : age.unit === 'min' ? `Checked ${age.n} min ago` : `Checked ${age.n} h ago`,
  checkedAt: (at: string) => `Checked ${at}`,
  notCheckedYet: 'Not checked yet',
  checkFailed: (msg: string) => `Market data check failed: ${msg}`,
  checkedOffline: (text: string) => `${text} · not connected`,
  connectToCheck: 'Connect to IB to check',
  /** The short note next to a market's tag (logic.ts → rowState). */
  rowNote: {
    closed: 'Market closed',
    delay: '15–20 min delay',
    notSubscribed: 'Not subscribed',
    paused: 'Paused',
    noAnswer: 'No answer from IB',
    noLine: 'No free line',
    notTested: 'Not tested',
  } as Record<RowNote, string>,
  /** The first line of a market row's tooltip. */
  rowTip: {
    closed: 'The market is closed: prices show the last values.',
    delay: 'IB sends this market 15–20 min late: this account has no live subscription for it.',
    notSubscribed: 'This account has no live subscription for this market, and IB sends no delayed data for it.',
    paused: 'IB sends market data to one session at a time, and your IB login has a live session elsewhere.',
    noAnswer: 'IB did not answer within 8 seconds. Look at the data farms in Settings › Connection and check again.',
    noLine: 'All of Tape’s market data lines are in use (IB allows 100). Close some watchlists or option chains and check again.',
    noOption: 'The SPY option chain could not be loaded, so no option was tested. Check again in a moment.',
    interrupted: 'The connection closed during the check.',
  } as Record<RowTip, string>,
  /** A competing session (10197): the one state the user has to act on. */
  competing: {
    t: 'Market data paused',
    d: 'Your IB login is also open in TWS, IBKR Mobile or Client Portal, and IB sends market data to one session at a time. Log out there and quotes come back on their own. Orders and positions keep working.',
  },
  /** Lines under the market rows (logic.ts → checkAttention). */
  hint: {
    notShared:
      'Nothing is live on this paper account. If your live account has subscriptions, share its market data with this paper account in Client Portal › Settings › Paper Trading Account. It can take up to a day.',
    lines: 'All market data lines are in use. Close some watchlists or option chains, then check again.',
  } as Record<Hint, string>,
  stWord: { live: 'live', frozen: 'frozen', delayed: 'delayed', nodata: 'no data' } as Record<MarketCheckStatus, string>,
  viaTip: (x: string) =>
    `Live from ${x} only: these are ${x}'s own best bid and ask, not the consolidated quote. IB sends this account SMART (consolidated) data delayed.`,
  inSession: (text: string) => `This session: ${text}`,
  depthViaTip: (x: string) => `Level 2 arrives from ${x} only; the other exchanges' books need their own subscriptions.`,
  depthPartialText: (missing: string[]) =>
    `IB sends no book from ${missing.join(', ')} (2152): those need depth subscriptions such as NASDAQ TotalView (NASDAQ), NYSE OpenBook (NYSE) or NYSE ArcaBook (ARCA), enabled for the API.`,
  fallbackInUse: (pairs: ExchangePair[]) => `Exchange quotes this session: ${pairs.map((p) => `${p.symbol} (${p.exchange})`).join(', ')}`,
  /** The market rows (Level 2's only in Technical details: it has its switch row). */
  markets: {
    stk: { l: 'US stocks', d: 'Stocks and ETFs, incl. extended hours' },
    opt: { l: 'US options', d: 'Option quotes and trades' },
    depth: { l: 'Level 2', d: '10-level book' },
    ind: { l: 'Indices', d: 'SPX, VIX and more' },
  } as Record<MarketRow, Pair>,
  obsNone: 'No quotes yet',
  obsDepthNone: 'Not requested',
  obsDisconnected: 'Not connected',
  obsLive: (n: number) => `${n} live`,
  obsFrozen: (n: number) => `${n} frozen`,
  obsDelayed: (n: number) => `${n} delayed`,
  obsError: (code: number | undefined, n: number) => `error ${code ?? '?'}${n > 1 ? ` ×${n}` : ''}`,
  obsDepth: (sym: string, n: number) => `${sym} · ${n} levels`,
  depthTitle: 'Market Depth',
  depthDesc:
    'A 10-level book on the Trade page and 5 levels a side in the order ticket. While open it uses one of your IB depth lines (3 by default, shared with TWS).',
  depthSwitch: 'Show Level 2',
  depthTesting: 'Testing what IB sends…',
  /** The line under the Level 2 switch (logic.ts → depthNote); `depth`: the exchanges IB sends a book from. */
  depthNote: {
    partial: (depth: string[]) =>
      !depth.length
        ? 'Only some exchanges’ books, so Level 2 shows part of the orders.'
        : `Only the ${depth.join(', ')} book${depth.length > 1 ? 's' : ''}${depth.length === 1 && depth[0] === 'IEX' ? ' (a few percent of US volume)' : ''}, so Level 2 shows part of the orders.`,
    limit: 'No free depth line: TWS or another app is using them all.',
    noSub: 'Needs a Level 2 subscription such as NASDAQ TotalView.',
    noBook: 'No book in the last test.',
    unconfirmed: 'Book received, not yet confirmed as the full book.',
    auto: 'Full book. Turned on automatically.',
    autoEarlier: 'Turned on automatically by an earlier test.',
    full: 'Full book from IB.',
    notChecked: 'Needs NASDAQ TotalView or NYSE OpenBook. Not tested yet.',
  },
  details: 'Technical details',
  dAnswers: 'IB’s answers',
  dRequest: 'Requested with reqMarketDataType 4: live where subscribed, else delayed; last values while closed.',
  dAck: 'Subscribed but still delayed? In Client Portal › Settings › Market Data Subscriptions, confirm the market data API acknowledgement and your non-professional status.',
  fieldsT: 'Quote field sources',
  /** Rows of the quote field table (the close time in the user's clock format). */
  fields: (c: Clock) => [
    { l: 'Last (incl. extended hours)', tick: 'tick 4 LAST', d: 'Keeps updating pre-market and after hours' },
    { l: "Today's close", tick: 'tick 57 LAST_RTH_TRADE', d: `Needs genericTicks 318; shows the ${c.wall('16:00')} close after hours` },
    { l: 'Previous close', tick: 'tick 9 CLOSE', d: 'Prior session close, used for change' },
    { l: 'Open / High / Low', tick: 'tick 14 / 6 / 7', d: 'Regular session' },
    { l: 'Bid / Ask', tick: 'tick 1 / 2', d: 'Includes extended-hours quotes' },
  ],
  link: 'Manage market data subscriptions at IBKR ↗',
  issue: {
    10197:
      'This IB user is logged in to a live session elsewhere (TWS, IBKR Mobile or Client Portal), so IB sends no market data to this connection. Quotes show — until that session logs out; account, positions and orders still work.',
    354: 'No market data subscription for this instrument. Delayed data is used where IB offers it.',
    10167: 'Not subscribed: IB is sending delayed market data instead.',
    10168: 'Delayed market data is not enabled for this account.',
    162: 'IB rejected a historical data request. Charts may stay empty while this persists.',
  } as Record<number, string>,
  cacheTitle: 'Local Cache',
  cacheDesc:
    'Bars, contract details and option chains are stored on this computer, so charts open at once and IB is asked only for what is missing. Intraday bars are kept for 30 days, charts not opened for 90 days are removed, and the cache stays under 512 MB by removing the least recently used charts first, intraday charts not opened in the past week before all others.',
  /** "84.2 MB · 312 series · 1.2M bars" */
  cacheLine: (size: string, series: number, bars: number) => `${size} · ${f0(series)} series · ${compact(bars)} ${bars === 1 ? 'bar' : 'bars'}`,
  cacheOldest: (date: string) => `Least recently used chart: ${date}`,
  cacheLoading: 'Calculating…',
  cacheUnavailable: 'Size not available',
  cacheClear: 'Clear cache',
  cacheClearing: 'Clearing…',
  cacheClearTitle: 'Clear local cache',
  cacheSize: 'Size',
  cacheSeries: 'Series',
  cacheBars: 'Bars',
  cacheClearNote: 'Charts load their bars from IB again, which takes a while for long histories.',
  cacheCleared: 'Local cache cleared',

  // Trade
  confirmOrders: 'Confirm before sending',
  confirmOrdersD: 'Review contract, quantity and price in a dialog',
  defaultQty: 'Default order size',
  outsideRth: 'Allow outside RTH by default',
  outsideRthD: 'New orders start in Extended hours (pre-market and after-hours) instead of Regular hours',

  // Notifications
  notifDesc:
    'Every notification appears in the bell at the top right. The switches below control whether it is also pushed to the macOS / Windows notification center. All are on by default, so you get them even when the app is in the background.',
  rules: {
    fill: { l: 'Fills', d: 'Orders fully or partially filled' },
    order: { l: 'Order status', d: 'Submitted, modified, cancelled, rejected' },
    price: { l: 'Price alerts', d: 'A watchlist symbol hits your level' },
    opt: { l: 'Expiry & assignment', d: 'Near expiry, short assignment risk, early exercise before ex-div' },
    conn: { l: 'Connection', d: 'Disconnected from or reconnected to TWS / Gateway' },
    sys: { l: 'System', d: 'Updates, errors' },
  } as Record<'fill' | 'order' | 'price' | 'opt' | 'conn' | 'sys', Pair>,
  sound: 'Sound',
  soundD: 'Play a sound with system notifications',
  soundCats: {
    order: { l: 'Order notifications', d: 'Submitted, modified, cancelled, rejected' },
    fill: { l: 'Fill notifications', d: 'Full and partial fills' },
    other: { l: 'Other notifications', d: 'Price alerts, expiry & assignment, connection, system' },
  } as Record<'order' | 'fill' | 'other', Pair>,
  soundCatOff: 'System notifications of this kind are off, so they make no sound',
  soundNames: {
    none: 'None',
    'Notification.Default': 'Windows notification',
    'Notification.IM': 'Instant message',
    'Notification.Mail': 'Mail',
    'Notification.Reminder': 'Reminder',
    default: 'System default',
  } as Record<string, string>,
  soundPick: 'Choose a sound',
  soundPreview: 'Play a sample notification',
  soundPreviewNone: 'No sound selected',
  soundPreviewDnd: 'Do not disturb is on',
  dnd: 'Do not disturb',
  dndD: 'Pause all system notifications; the bell still records them',
  test: 'Send test notification',
  testD: 'The OS asks for permission the first time',

  // General
  accountId: 'Account ID',
  show: 'Show',
  hide: 'Hide',
  language: 'Language',
  timeFormat: 'Time format',
  hour12: '12-hour',
  hour24: '24-hour',
  theme: 'Theme',
  system: 'System',
  dark: 'Dark',
  light: 'Light',
  upColors: 'Up / down colors',
  cn: 'Red up, green down',
  us: 'Green up, red down',

  // Privacy & Security
  privacy: 'Privacy',
  lockScreen: 'Lock Screen',
  lockNoPin: 'Set a lock PIN to turn on the lock screen and auto-lock.',
  autoLock: 'Auto-lock when idle',
  autoLockD: 'No keyboard or mouse input on this computer',
  minutes: (n: number) => `${n} min`,
  custom: 'Custom',
  never: 'Never',
  customL: 'Custom duration',
  customD: '1 – 1440 minutes',
  minU: 'min',
  unlockWith: 'Unlock with',
  bio: (kind: BiometricKind) => BIO[kind],
  pinOnly: 'PIN only',
  bioOff: (b: LockBiometrics & { kind: BiometricKind }) =>
    b.reason === 'checking'
      ? `Checking whether ${BIO[b.kind]} can be used…`
      : b.reason === 'disabledByPolicy'
      ? `${BIO[b.kind]} is turned off by your administrator`
      : b.reason === 'notEnrolled'
        ? b.kind === 'touchId'
          ? 'Touch ID is not set up. Add a fingerprint in System Settings › Touch ID & Password'
          : 'Windows Hello is not set up. Set it up in Settings › Accounts › Sign-in options'
        : b.reason === 'noHardware'
          ? b.kind === 'touchId'
            ? 'Touch ID is not available on this Mac or not set up (a closed lid also turns it off)'
            : 'This PC has no Windows Hello camera or fingerprint reader, or it is not set up'
          : `${BIO[b.kind]} is not available right now`,
  unlockSound: 'Unlock sound',
  unlockSoundD: 'Play a soft click when unlocked',
  pinL: 'Lock PIN',
  pinD: '6 characters (letters, digits or symbols). Only unlocks Tape; separate from your IBKR login',
  pinSet: 'Set',
  pinChange: 'Change',
  pinRemove: 'Remove',

  // API log
  logDesc:
    'Every TCP message between the client and TWS / IB Gateway. “→ SEND” is a request from the client to TWS; “← RECV” is data or a callback from TWS. Click any row for all fields and the raw frame.',
  fAll: 'All',
  fOut: 'Sent',
  fIn: 'Received',
  fErr: 'Errors',
  search: 'Search message, reqId or content',
  raw: 'Raw frames',
  pause: 'Pause',
  resume: 'Resume',
  clear: 'Clear',
  export: 'Export .log',
  colTime: 'Time',
  colDir: 'Direction',
  colMsg: 'Message',
  colBody: 'Content',
  colBytes: 'Bytes',
  send: '→ SEND',
  recv: '← RECV',
  paused: (n: string) => `Display paused, recording continues · ${n} new · click to resume`,
  foot: (a: string, b: string) => `Showing newest ${a} of ${b} · newest first`,
  emptyLog: 'No API messages yet',
  noMatch: 'No matching messages',
  writeFile: 'Also write to log file',
  revealFile: 'Show the log file',
  keep: 'Keep logs for',
  keepDays: (d: number) => `${d}d`,
  keepNote: 'Log files older than this are deleted on launch',
  clearTitle: 'Clear log',
  clearEntries: 'Entries',
  clearNote: 'Clears the in-app log. Log files already written are kept.',
  clearLabel: 'Clear',
  exported: (path: string) => `Exported to ${path}`,

  // Shortcuts
  keys: {
    command: 'Search symbol',
    buy: 'Buy',
    sell: 'Sell',
    qty: 'Qty +/−',
    submit: 'Submit order',
    cancelLast: 'Cancel last open order',
    pages: 'Switch page',
    settings: 'Settings',
    theme: 'Toggle theme',
    lock: 'Lock',
  } as Record<ShortcutId, string>,
};

const zh: typeof en = {
  nav: {
    view: '通用',
    conn: '连接',
    data: '行情',
    trade: '交易',
    notif: '通知',
    sec: '隐私与安全',
    keys: '快捷键',
    log: 'API 日志',
  },

  connDesc: '通过 TWS 或 IB Gateway 的 API 端口连接。需在 TWS 中启用 “Enable ActiveX and Socket Clients”。',
  host: '主机',
  port: '端口',
  clientId: 'Client ID',
  hostInvalid: '请输入主机名或 IP 地址',
  portInvalid: '端口范围为 1–65535',
  cidInvalid: '需为 0–999,999,999 的整数',
  cidHelp:
    '连到同一个 TWS / IB Gateway 的每个程序（最多同时 32 个）都要用不同的 Client ID：ID 已被占用时，IB 会拒绝后来的连接（错误 326）。订单归属于下单时的 Client ID；Tape 能看到所有客户端的订单，但只能修改或撤销自己的。设为 0 时，Tape 连接期间在 TWS 里手动下的单也归 Tape 管理。',
  advanced: '高级：Client ID',
  expand: '展开 ▾',
  collapse: '收起 ▴',
  connect: '连接',
  disconnect: '断开连接',
  stop: '停止',
  connectedTo: (app: string, addr: string) => `已连接 ${app} ${addr}`,
  paperAccount: '模拟账户',
  liveAccount: '实盘账户',
  serverVersion: (v: number) => `服务器版本 ${v}`,
  connecting: (addr: string) => `正在连接 ${addr}…`,
  reconnecting: (n: number, max: number) => `正在重连 · 第 ${n} / ${max} 次`,
  notConnectedHelp: '未连接。确认 TWS 已启动并开放 API 端口。',
  notConnected: '未连接',
  farms: '数据农场',
  viewAll: '查看全部 API 日志 ›',
  noMessages: '暂无 API 消息',
  autoReconnect: '断线自动重连',
  autoReconnectD: '每 5 秒重试，最多 10 次',
  disconnectNote: '断开后行情、订单回报都会停止更新，挂单仍在 IBKR 服务器上有效。',
  disconnectLabel: '断开',
  reconnectTitle: '使用新设置重新连接',
  reconnectNote: '当前连接会断开，并用新设置重新连接。恢复连接前行情、订单回报都会停止更新，挂单仍在 IBKR 服务器上有效。',
  reconnectLabel: '重新连接',
  connectFailed: (msg: string) => `连接失败：${msg}`,

  dataDesc: 'Tape 自动为每个市场选用 IB 能提供的最好行情：已订阅的为实时，其余为 15–20 分钟延迟。',
  checkNow: '立即检测',
  checkNowTip: '重新检测所有市场，包括 Level 2 盘口，最长约 20 秒。',
  checking: '检测中…',
  checkedAgo: (age: Age, at: string) =>
    !age ? `${at} 检测` : age.unit === 'now' ? '刚刚检测' : age.unit === 'min' ? `${age.n} 分钟前检测` : `${age.n} 小时前检测`,
  checkedAt: (at: string) => `${at} 检测`,
  notCheckedYet: '尚未检测',
  checkFailed: (msg: string) => `行情检测失败：${msg}`,
  checkedOffline: (text: string) => `${text} · 未连接`,
  connectToCheck: '连接 IB 后才能检测',
  rowNote: {
    closed: '休市',
    delay: '延迟 15–20 分钟',
    notSubscribed: '未订阅',
    paused: '已暂停',
    noAnswer: 'IB 未回应',
    noLine: '没有空闲线路',
    notTested: '未检测',
  },
  rowTip: {
    closed: '休市中：显示最后的价格。',
    delay: 'IB 以 15–20 分钟延迟发送这个市场的行情：此账户没有它的实时订阅。',
    notSubscribed: '此账户没有这个市场的实时订阅，IB 也不提供它的延迟行情。',
    paused: 'IB 同一时间只向一个会话推送行情，而你的 IB 账号正在别处登录。',
    noAnswer: 'IB 在 8 秒内没有回应。请在 设置 › 连接 查看数据农场状态后再检测。',
    noLine: 'Tape 的行情线路已全部占用（IB 上限 100 条）。关闭部分自选或期权链后再检测。',
    noOption: '无法加载 SPY 期权链，未能检测期权。请稍后再检测。',
    interrupted: '检测期间连接已断开。',
  },
  competing: {
    t: '行情已暂停',
    d: '你的 IB 账号同时在 TWS、IBKR Mobile 或 Client Portal 登录，而 IB 同一时间只向一个会话推送行情。在那边退出后报价会自动恢复；订单和持仓不受影响。',
  },
  hint: {
    notShared: '此模拟账户没有任何实时行情。如果实盘账户已订阅行情，请在 Client Portal › 设置 › 模拟交易账户 中把行情共享给模拟账户，最长一天生效。',
    lines: '行情线路已全部占用。关闭部分自选或期权链后再检测。',
  },
  stWord: { live: '实时', frozen: '冻结', delayed: '延迟', nodata: '无数据' },
  viaTip: (x: string) => `仅 ${x} 有实时数据：这是 ${x} 自己的最优买卖价，不是全市场合并报价。IB 向本账户推送的 SMART（合并）行情是延迟的。`,
  inSession: (text: string) => `本次会话：${text}`,
  depthViaTip: (x: string) => `仅 ${x} 提供深度行情；其他交易所的盘口需要另外订阅。`,
  depthPartialText: (missing: string[]) =>
    `IB 不提供 ${missing.join('、')} 的盘口（2152）：需要相应的深度订阅，例如 NASDAQ TotalView（NASDAQ）、NYSE OpenBook（NYSE）或 NYSE ArcaBook（ARCA），并为 API 开通。`,
  fallbackInUse: (pairs: ExchangePair[]) => `本次会话的交易所报价：${pairs.map((p) => `${p.symbol}（${p.exchange}）`).join('、')}`,
  markets: {
    stk: { l: '美股', d: '股票和 ETF，含盘前盘后' },
    opt: { l: '美股期权', d: '期权报价与成交' },
    depth: { l: 'Level 2 盘口', d: '10 档盘口' },
    ind: { l: '指数', d: 'SPX、VIX 等' },
  },
  obsNone: '暂无报价',
  obsDepthNone: '未请求',
  obsDisconnected: '未连接',
  obsLive: (n: number) => `实时 ${n}`,
  obsFrozen: (n: number) => `冻结 ${n}`,
  obsDelayed: (n: number) => `延迟 ${n}`,
  obsError: (code: number | undefined, n: number) => `错误 ${code ?? '?'}${n > 1 ? ` ×${n}` : ''}`,
  obsDepth: (sym: string, n: number) => `${sym} · ${n} 档`,
  depthTitle: '深度行情',
  depthDesc: '在交易页显示 10 档盘口，在下单面板显示买卖各 5 档。显示期间占用一条 IB 深度线路（默认 3 条，与 TWS 共用）。',
  depthSwitch: '显示 Level 2 盘口',
  depthTesting: '正在检测 IB 提供的盘口…',
  depthNote: {
    partial: (depth: string[]) =>
      !depth.length
        ? '只有部分交易所的盘口，Level 2 只显示部分挂单。'
        : `只有 ${depth.join('、')} 的盘口${depth.length === 1 && depth[0] === 'IEX' ? '（只占美股成交量的几个百分点）' : ''}，Level 2 只显示部分挂单。`,
    limit: '没有空闲的深度线路：已被 TWS 或其他程序占满。',
    noSub: '需要 Level 2 订阅，例如 NASDAQ TotalView。',
    noBook: '上次检测没有收到盘口。',
    unconfirmed: '已收到盘口，尚未确认是否完整。',
    auto: '完整盘口，已自动开启。',
    autoEarlier: '已由之前的检测自动开启。',
    full: 'IB 提供完整盘口。',
    notChecked: '需要 NASDAQ TotalView 或 NYSE OpenBook，尚未检测。',
  },
  details: '技术细节',
  dAnswers: 'IB 的回复',
  dRequest: '请求方式 reqMarketDataType 4：已订阅为实时，否则为延迟；休市时为最后数值。',
  dAck: '已订阅却仍是延迟？请在 Client Portal › 设置 › 市场数据订阅 中确认行情 API 声明和非专业用户身份。',
  fieldsT: '报价字段来源',
  fields: (c: Clock) => [
    { l: '最新价（含盘前盘后）', tick: 'tick 4 LAST', d: '盘前盘后时段也持续更新' },
    { l: '今日收盘价', tick: 'tick 57 LAST_RTH_TRADE', d: `需 genericTicks 318，盘后显示 ${c.wall('16:00')} 收盘价` },
    { l: '昨收', tick: 'tick 9 CLOSE', d: '上一交易日收盘价，用来计算涨跌' },
    { l: '开 / 高 / 低', tick: 'tick 14 / 6 / 7', d: '常规时段' },
    { l: '买一 / 卖一', tick: 'tick 1 / 2', d: '含盘前盘后报价' },
  ],
  link: '在 IBKR 管理行情订阅 ↗',
  issue: {
    10197: '此 IB 用户在其他地方登录了实盘会话（TWS、IBKR Mobile 或 Client Portal），IB 不向本连接推送行情。该会话退出前报价显示 —；账户、持仓和订单不受影响。',
    354: '该合约没有行情订阅，IB 提供时改用延迟数据。',
    10167: '未订阅：IB 改为推送延迟行情。',
    10168: '此账户未开通延迟行情。',
    162: 'IB 拒绝了历史数据请求，问题持续期间图表可能为空。',
  },
  cacheTitle: '本地缓存',
  cacheDesc:
    'K线、合约详情和期权链保存在本机，图表可以立即打开，只向 IB 请求缺少的部分。日内K线保留 30 天，90 天未打开的图表会被删除；缓存超过 512 MB 时先删除最久未用的图表，其中一周内未打开的日内图表最先删除。',
  cacheLine: (size: string, series: number, bars: number) => `${size} · ${f0(series)} 个序列 · ${compact(bars)} 根K线`,
  cacheOldest: (date: string) => `最久未用的图表：${date}`,
  cacheLoading: '计算中…',
  cacheUnavailable: '无法读取缓存大小',
  cacheClear: '清除缓存',
  cacheClearing: '正在清除…',
  cacheClearTitle: '清除本地缓存',
  cacheSize: '大小',
  cacheSeries: '序列',
  cacheBars: 'K线',
  cacheClearNote: '图表会重新从 IB 加载K线，较长的历史需要一些时间。',
  cacheCleared: '本地缓存已清除',

  confirmOrders: '下单前确认',
  confirmOrdersD: '弹窗核对合约、数量、价格',
  defaultQty: '默认下单数量',
  outsideRth: '默认允许盘前盘后',
  outsideRthD: '新订单的交易时段默认为盘前盘后，而不是常规时段',

  notifDesc: '所有通知都会显示在右上角铃铛里。下面的开关控制是否同时推送到 macOS / Windows 系统通知中心，默认全部开启，应用在后台时也能收到。',
  rules: {
    fill: { l: '成交', d: '订单全部或部分成交' },
    order: { l: '订单状态', d: '提交、改单、撤单、被拒' },
    price: { l: '价格提醒', d: '自选标的触发你设置的价位' },
    opt: { l: '期权到期与指派', d: '临近到期、空头被指派风险、除息前提前行权' },
    conn: { l: '连接', d: '与 TWS / Gateway 断开或重连' },
    sys: { l: '系统', d: '更新、错误等' },
  },
  sound: '提示音',
  soundD: '系统通知播放提示音',
  soundCats: {
    order: { l: '下单通知', d: '提交、改单、撤单、被拒' },
    fill: { l: '成交通知', d: '全部成交与部分成交' },
    other: { l: '其他通知', d: '价格提醒、期权到期与指派、连接、系统' },
  },
  soundCatOff: '这类系统通知已关闭，不会播放提示音',
  soundNames: {
    none: '无',
    'Notification.Default': 'Windows 通知音',
    'Notification.IM': '即时消息',
    'Notification.Mail': '邮件',
    'Notification.Reminder': '提醒',
    default: '系统默认',
  },
  soundPick: '选择提示音',
  soundPreview: '试听：发送一条示例通知',
  soundPreviewNone: '未选择提示音',
  soundPreviewDnd: '勿扰模式已开启',
  dnd: '勿扰模式',
  dndD: '暂停所有系统通知，铃铛里照常记录',
  test: '发送测试通知',
  testD: '首次使用时系统会请求通知权限',

  accountId: '账户号',
  show: '显示',
  hide: '隐藏',
  language: '语言',
  timeFormat: '时间格式',
  hour12: '12 小时制',
  hour24: '24 小时制',
  theme: '主题',
  system: '跟随系统',
  dark: 'Dark',
  light: 'Light',
  upColors: '涨跌颜色',
  cn: '红涨绿跌',
  us: '绿涨红跌',

  privacy: '隐私',
  lockScreen: '锁屏',
  lockNoPin: '设置锁屏 PIN 后，锁屏和自动锁定才会生效。',
  autoLock: '无操作后自动锁定',
  autoLockD: '这台电脑没有键盘或鼠标操作',
  minutes: (n: number) => `${n} 分钟`,
  custom: '自定义',
  never: '从不',
  customL: '自定义时长',
  customD: '1 – 1440 分钟',
  minU: '分钟',
  unlockWith: '解锁方式',
  bio: (kind: BiometricKind) => BIO[kind],
  pinOnly: '仅 PIN',
  bioOff: (b: LockBiometrics & { kind: BiometricKind }) =>
    b.reason === 'checking'
      ? `正在检查 ${BIO[b.kind]} 是否可用…`
      : b.reason === 'disabledByPolicy'
      ? `${BIO[b.kind]} 已被管理员停用`
      : b.reason === 'notEnrolled'
        ? b.kind === 'touchId'
          ? '尚未设置 Touch ID，请在“系统设置 › 触控 ID 与密码”中添加指纹'
          : '尚未设置 Windows Hello，请在“设置 › 账户 › 登录选项”中设置'
        : b.reason === 'noHardware'
          ? b.kind === 'touchId'
            ? '这台 Mac 无法使用 Touch ID 或尚未设置（合上屏幕时也无法使用）'
            : '这台电脑没有 Windows Hello 摄像头或指纹识别器，或尚未设置'
          : `${BIO[b.kind]} 暂时不可用`,
  unlockSound: '解锁音效',
  unlockSoundD: '解锁成功时播放一声轻响',
  pinL: '锁屏 PIN',
  pinD: '6 位字符（字母、数字、符号均可），只用于解锁 Tape，与 IBKR 登录密码无关',
  pinSet: '设置',
  pinChange: '修改',
  pinRemove: '移除',

  logDesc:
    '记录客户端与 TWS / IB Gateway 之间的全部 TCP 消息。“→ 发送”是客户端发给 TWS 的请求，“← 接收”是 TWS 返回的数据和回调。点击任意一行查看完整字段和原始报文。',
  fAll: '全部',
  fOut: '发送',
  fIn: '接收',
  fErr: '错误',
  search: '搜索消息名、reqId 或内容',
  raw: '原始报文',
  pause: '暂停',
  resume: '继续',
  clear: '清空',
  export: '导出 .log',
  colTime: '时间',
  colDir: '方向',
  colMsg: '消息',
  colBody: '内容',
  colBytes: '字节',
  send: '→ 发送',
  recv: '← 接收',
  paused: (n: string) => `已暂停显示，记录仍在继续 · 期间新增 ${n} 条 · 点此继续`,
  foot: (a: string, b: string) => `显示最新 ${a} 条 / 共 ${b} 条 · 最新在上`,
  emptyLog: '暂无 API 消息',
  noMatch: '没有匹配的消息',
  writeFile: '同时写入日志文件',
  revealFile: '显示日志文件',
  keep: '日志保留',
  keepDays: (d: number) => `${d} 天`,
  keepNote: '超过保留天数的日志文件在启动时自动删除',
  clearTitle: '清空日志',
  clearEntries: '条数',
  clearNote: '只清空应用内的日志，已写入文件的日志不受影响。',
  clearLabel: '清空',
  exported: (path: string) => `已导出到 ${path}`,

  keys: {
    command: '搜索代码',
    buy: '买入',
    sell: '卖出',
    qty: '数量 +/−',
    submit: '提交订单',
    cancelLast: '撤销最后一笔挂单',
    pages: '切换页面',
    settings: '设置',
    theme: '切换主题',
    lock: '锁定',
  },
};

export const useSettingsMessages = createMessages({ en, zh });

export type SettingsMessages = typeof en;
