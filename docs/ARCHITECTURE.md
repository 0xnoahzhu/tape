# Architecture

Tape is an Electron app built by Vite 8 into these bundles:

| Bundle | Source | Output | Notes |
| --- | --- | --- | --- |
| main | `src/main` | `out/main/index.js` (ESM) | Owns the IB API connection, persistence, OS integration |
| db worker | `src/main/db/worker.ts` | `out/main/dbWorker.js` (ESM) | SQLite on a worker thread (see *Database*) |
| preload | `src/preload` | `out/preload/index.cjs` (CJS) | Exposes `window.tape` (typed `TapeApi`) via `contextBridge` |
| renderer | `src/renderer` | `out/renderer` | React 19 + zustand; no Node access (sandboxed) |

`src/shared` holds types and pure helpers used by both sides (no Electron or DOM imports).
The app has no npm runtime dependencies: the TWS API client and the database are in-repo and use
only Node built-ins (`node:net`, `node:sqlite`, `node:worker_threads`); React and zustand are bundled
into the renderer.

## Data flow

```
IB Gateway / TWS ──socket──▶ main (services) ──TapeEvent──▶ renderer store (zustand) ──▶ React
                              ▲                                   │
                              └────────── TapeApi (invoke) ◀──────┘
```

* The main process is the single source of truth for everything that comes from IB or is persisted
  (settings, watchlists, price alerts, notifications in JSON files; NAV history and the executions
  journal in `tape.db`).
* The renderer receives a snapshot on startup (`getSnapshot`) and then push events
  (`src/shared/ipc.ts → TapeEvent`). `src/renderer/src/state/bridge.ts` applies them to the store.
* Renderer writes go through `window.tape.*` (`TapeApi`). The main process persists and broadcasts
  the new state back, so the renderer never keeps a diverging copy of persisted data.
* Quotes are subscription based (see *Quote subscriptions*); the API log is streamed on demand
  (see *API log*).

## Main process services

`src/main/context.ts` declares every service interface. `src/main/index.ts` creates them in order and
registers one `ipcMain.handle('tape:<method>')` per `TapeApi` method. Services reach each other lazily
through the shared `MainContext` (never inside their factory).

| Module | Responsibility |
| --- | --- |
| `store.ts` | JSON persistence in `userData` (settings, watchlists, alerts, notifications, window bounds; `nav.json` only for its one-time import into `tape.db`); the lock PIN is not here (`lock/lockFile.ts`) |
| `db/` | `ctx.db`: SQLite caches and journals in a worker thread (see *Database*) |
| `ib/tws/` | Dependency-free TWS API client (`IBApi`, see *TWS API client*) |
| `ib/connection.ts` | `IBApi` lifecycle, handshake, auto-reconnect, heartbeat, request/order id allocation, error routing |
| `ib/apiLog.ts` | Records every sent/received frame, on-demand streaming to the API log views, daily log files, retention |
| `ib/account.ts` | Account summary, positions/portfolio, P&L, NAV sampling (`navHistory.ts`, stored in `ctx.db.nav`) |
| `ib/orders.ts` | Open orders of all clients, order status, place/modify/cancel, executions and commissions (journaled in `ctx.db.executions`) |
| `market/contracts.ts` | Symbol search, contract details cache |
| `market/quotes.ts` | Market data subscriptions, tick mapping, batching; demo simulator when `TAPE_DEMO=1` |
| `market/history.ts` | Historical bars per interval (see *Historical bars*) |
| `market/depth.ts` | Level 2 book |
| `market/options.ts` | Option chain parameters (`reqSecDefOptParams`) |
| `market/corporateEvents.ts` | Upcoming earnings of the holdings from Wall Street Horizon (see *Corporate events*) |
| `market/marketCheck.ts` | The active market data check (see *Market data check*) |
| `market/alerts.ts` | Price alert evaluation |
| `notifications.ts` | In-app notification list + OS notifications (see *Notification sounds*) |
| `notificationSound.ts`, `soundPlayer.ts` | Per-platform notification sound options; the macOS sound player (afplay) |
| `appearance.ts` | Theme (`nativeTheme.themeSource`) and theme-matched dock/window icon |
| `menu.ts` | Application menu (localized), menu commands |
| `lock/` | `ctx.lock`: lock state, PIN, idle auto-lock, biometrics, Forgot-PIN reset (see *Lock screen*) |
| `ipcDispatch.ts` | The `InvokeResult` envelope around every handler and the lock's IPC allow-list |

### Connection

`connect()` → `connecting` → server version, `managedAccounts`, `nextValidId` → `connected`, then
every `onReady` listener (re)issues its requests; they run again after IB's 1101 (data lost). With
auto-reconnect on, an unexpected close retries every 5 s, at most 10 times (`reconnecting`); so does
a failed first attempt of the reconnect that a host / port / client id change starts. A failed
manual connect is reported and not retried; `disconnect()` never reconnects. A `reqCurrentTime`
heartbeat every 30 s measures latency.

### Orders

Orders are keyed by client id + order id (`orderMapping.ts → orderKey`), since order ids are per
API client. `reqAllOpenOrders` shows the orders of every client (TWS is client 0), but `modifyOrder`
/ `cancelOrder` act only on orders of the connected client id: an id that only another client's
order has, or no order has, is refused without sending anything (IB would apply it to this
client's order with that id). `cancelAllOrders` (`reqGlobalCancel`) cancels every order of the
account. With client id 0, orders entered in TWS afterwards are bound to Tape (`reqAutoOpenOrders`)
and count as its own. Tape has no read-only mode of its own: with *Read-Only API* on in TWS / IB
Gateway, IB rejects orders with error 321, and the renderer's toast adds where to turn it off
(`state/orderActions.ts → orderErrorText`). Saved settings that still have Tape's former read-only
switch on get a one-time notice in the notification list saying so (`store.ts`).

Time in force and trading session (`shared/orderTiming.ts`) are checked by the same rules in the
order ticket, which disables choices that do not combine and says why, and in `orderBuilder.ts`,
which refuses such requests from any caller. A request carries `tif`, `session` and, for GTD,
`goodTillDate` ("yyyyMMdd HH:mm:ss US/Eastern"; the ticket defaults it to the next session close
from the contract's liquid hours, the end of the day's last session on exchanges with a lunch
break). Sessions are sent as:

| Session | Contract | Order |
| --- | --- | --- |
| Regular hours | SMART | `outsideRth` off |
| Extended hours | SMART | `outsideRth` on |
| Overnight | exchange `OVERNIGHT`, primary exchange set | TIF DAY |
| Overnight + Day | SMART | TIF DAY, `includeOvernight` (server version 189+); IB turns `outsideRth` on and reports the TIF as "OVERNIGHT + DAY" |

On the paper account IB accepted DAY, GTC, GTD, IOC and OPG (as limit or market on open) for US
stocks, FOK only for options (201 for stocks), OPG not for SMART-routed options, and only DAY limit
orders in the overnight sessions (10052 / 201 for GTC, GTD, IOC, OPG or stop orders), there also
without iceberg, price condition or good-after time (201); it ignores outside RTH for IOC, FOK and
OPG (2109). Bracket children take the parent's TIF, and IB rejects a stop-loss with IOC or FOK
(201), so a bracket cannot use IOC, FOK or OPG. Overnight-only orders are directly routed: with
the API precaution "Bypass Redirect Order warning for Stock API orders" off, IB refuses them
(10329) and the toast says where to turn it on. `orderMapping.ts` maps the OVERNIGHT venue,
`includeOvernight` / "OVERNIGHT + DAY" and `goodTillDate` back into `WorkingOrder.session` /
`tif` / `goodTillDate` (the contract stays the SMART one), so the orders list, notifications, CSV
export and "Modify" keep them. A working order cannot change its session (IB answers 105 for another venue, 462 for
`includeOvernight`), and its TIF only between DAY and GTC or to IOC (462 for any change to or from
GTD or OPG; a GTD expiry can change): `shared/orderTiming.ts → tifChangeAllowed`. While modifying,
the ticket locks the session and the TIFs IB refuses, a "Modify" from any list starts from the
order's TIF, expiry and session (`store.ts → withModifiedTiming`), and `modify()` refuses other
requests without sending them.

IB rejects some orders only after taking them: an Inactive `openOrder`, then the reason (201).
`place()` / `modify()` do not count an Inactive order as accepted: they fail with that reason, or
when the 2 s wait ends with the order still Inactive. IB may also acknowledge an order
(PreSubmitted) and reject it half a second later: for 5 s the renderer replaces the "Submitted" /
"Modified" toast with the failure (`state/orderActions.ts → watchLateRejection`). The rejection
notification waits up to 1 s for the reason, and a request is announced as rejected once (the
order IB reported, or else the request).

#### Order types and attributes

Everything else about an order is checked by `shared/orderRules.ts`, again in the ticket and in
`orderBuilder.ts` (which refuses for any caller): the prices each type needs, which instruments,
sessions and TIFs a type takes, fill attributes, IB algos and their parameters, conditions,
bracket stop types, adjustable stops, OCA groups, directed routing, combo routing and forex cash
quantities. `orders.ts → prepare` also checks the contract's own list from IB
(`ContractInfo.orderTypes`: `MIT`, `MIDPX`, `AON`, `ALGO`, `COND`, …; MES lists no `AON`, `MOC`,
`LOC` or `MIDPX`, exactly what IB refused for it) and its valid exchanges. The list is not complete
(stocks list `CASHQTY`, which the API refuses with 10244), so the static rules always apply. What IB
answered on the paper account (DUP899854, server version 193, outside regular hours):

| Item | IB fields | Paper account |
| --- | --- | --- |
| MIT / LIT | `auxPrice` trigger (+ `lmtPrice`) | stocks, options, futures, forex; MIT ignores outside RTH (2109), so regular hours only |
| MOC / LOC | (+ `lmtPrice`) | stocks; DAY only (201 for GTC); a modify gets no `openOrder` back, so `modify()` then asks `reqOpenOrders` (the order shows PendingSubmit with the new values) |
| MTL | – | stocks, options, futures; regular hours |
| TRAIL LIMIT / TRAIL LIT | `auxPrice` or `trailingPercent`, `trailStopPrice`, `lmtPriceOffset` | the initial stop is required, and exactly one of limit price and offset (321); IB reports `lmtPrice` as stop + offset, so the offset is read back |
| TRAIL MIT | as TRAIL | accepted |
| MIDPRICE | optional cap in `lmtPrice` | US stocks only (387 for options, futures, the OVERNIGHT venue); regular hours only (321) |
| REL | `auxPrice` offset or `percentOffset`, cap in `lmtPrice` | accepted (IB's docs say not on paper) |
| SNAP MID / SNAP MKT | `auxPrice` offset | IB ignores a cap (echoes `lmtPrice` 0) |
| PEG MID | `auxPrice` offset, cap | accepted on SMART (387 on NASDAQ); regular hours only (IB drops outside RTH: the echo has `outsideRth` false) |
| MIT / LIT / TRAIL MIT / TRAIL LIT | `auxPrice` trigger (trailing: `trailStopPrice`) | a buy triggers below the market, a sell above: a trigger already through the market fills at once (a BUY forex TRAIL LIT with its trigger above filled on paper), so the ticket starts on the touched side and refuses the wrong one |
| All or none | `allOrNone` | stocks and options; 10257 for futures, combos, bracket children and with an IB algo; 201 with an iceberg and in the overnight sessions |
| Minimum quantity | `minQty` | options only (10256 for stocks and futures) |
| Hidden | `hidden` | stocks (SMART, NASDAQ, ARCA); 10255 with a display size; 201 with TIF OPG ("Only DAY/LIMIT allowed for hidden order"; GTC and GTD accepted) |
| Sweep to fill | `sweepToFill` | stock limit orders via SMART (10267 for options); not in the overnight sessions (10267 / 201) |
| Discretionary | `discretionaryAmt` | stock and option limit orders; options at most 10 % of the limit (201); 201 with overnight + day, dropped without a word on the OVERNIGHT venue |
| Iceberg | `displaySize` | limit orders; 10255 on stops and directed stock orders; stock icebergs on SMART answered 201 "multiple of lot size" at night (to be checked in regular hours) |
| Trigger method | `triggerMethod`, `PriceCondition.triggerMethod` | 1–8 accepted on stops; IB also takes "last" for forex, where it can never trigger, so forex offers default, bid/ask and midpoint only |
| IB algos | `algoStrategy`, `algoParams` (switches 1 / 0, times "HH:MM:SS US/Eastern") | regular hours only (201); a modify keeps the algo only when it is sent again, changes its parameters, but refuses dropping (440) or adding (439) one; TWAP refuses `strategyType` (443); accumulate / distribute wants its active times as "HH:MM:SS" UTC (10315), and without them IB fills in both ends at the time of placement (read back as no window); no hidden (152), sweep, discretion (201), display size (10255) or minimum quantity (10256); DAY only, GTC also for Adaptive and AD (201 for the others, GTD, IOC and OPG); no good-after time (201) |
| Conditions | price (index on its exchange), time (after only), percent change, volume (int32), margin, execution; AND / OR; `conditionsCancelOrder` | conditional submission only for LMT, MKT, MIDPRICE, REL, SNAP (148: Tape allowed stop orders before); cancel only LMT and MIDPRICE; a modify changes values (price, time, trigger method, incl. ext. hours) but silently ignores adding, removing, switching submit / cancel, an operator or an AND / OR |
| Bracket stop-loss | STP, STP LMT, TRAIL, TRAIL LIMIT child | trailing children only under LMT / STP LMT parents (328); children never take all or none; IB puts the children in its own OCA group (type 3), which is not shown as the user's |
| Adjustable stop | `triggerPrice`, `adjustedOrderType`, `adjustedStopPrice`, `adjustedStopLimitPrice`, `adjustedTrailingAmount`, `adjustableTrailingUnit` | on a bracket stop-loss and on a standalone stop |
| OCA | `ocaGroup`, `ocaType` 1 / 2 / 3 | one type per group (201); group or type cannot change on a working order (10326 / 10327) |
| Directed routing | contract `exchange` | stock LMT / MKT / STP on NASDAQ, ARCA, IEX…; `validExchanges` names them ("NASDAQ", not "ISLAND": 464). An echo's venue is read back as a route only for a stock IB reaches through SMART (known from this client's own orders; otherwise US dollar stocks): a SEHK stock's venue is its own exchange (`orderMapping.ts → SmartRouted`) |
| Combos | `smartComboRoutingParams` NonGuaranteed=1 | kept on modify; combos take LMT and MKT |
| Forex cash quantity | `cashQty`, `totalQuantity` 0 | IB computes the quantity; stocks refuse it (10244) |
| What-if | `whatIf`, `transmit` | `openOrder`s flagged whatIf, no `orderStatus`: for a stock limit order first one with a placeholder commission 0 and IB's price-band notice, then one with margin before / change / after and the commission (a min–max range for limit orders); `preview()` merges the parts, the later commission replacing the placeholder |

Not offered, with IB's answer: MKT PRT / STP PRT (387 for stocks and MES), TIF AUC (201),
`postToAts` (10274), AccuDistr (201), stock cash quantities and fractional shares (10244 / 10243),
PEG MKT and PASSV REL (387), hedge children (10063 for a USD stock), crypto (no answer on paper).
Not offered by choice: SNAP PRIM and the auction order (directed venues only), VOL, PEG STK and PEG
BENCH (options-desk pricing models with many inputs), scale orders (ScaleTrader's dozen fields,
408–449), per-leg combo prices and combo-only types such as REL + MKT, `autoCancelParent`,
`manualOrderIndicator` (not required by IB for paper futures orders), the `advancedErrorOverride`
"send anyway" (IB Gateway's precaution settings are the intended control), GTD by `duration`, DTC
and the GTC active window (covered by GTD and good-after time), T+0 and pre-borrow, third-party
algos (live accounts only), and every institutional, advisor (FA allocation, model code),
regulatory (MiFID II, soft dollars) or deprecated field (`eTradeOnly`, `firmQuoteOnly`,
`nbboPriceCap`: 10268–10270). Fields newer than server version 193 (`postOnly`,
`seekPriceImprovement`, `deactivate`, …) need the handshake raised first. Exercising or lapsing
options is a separate request (`exerciseOptions`), not part of an order, and has no client method
yet.

A modify replaces the whole order at IB: `orders.ts → modify` fills in the working order's attributes
the request leaves out (`orderRules.ts → withOrderAttributes`; `false`, 0 and '' turn one off) and
refuses, without sending, what IB refuses or ignores (`modifyProblems`: instrument, side, order type,
algo, OCA group, conditions added / removed / switched or their operators and joins changed,
destination, combo routing, trigger method (kept without a word), sweep to fill (off ignored, on
201), a relative order's percent / amount offset (201), any change to a forex order sized by cash
(10241), and dropping a discretionary amount, good-after time or note: an empty field keeps IB's
value). IB answers a modify it refuses with the unchanged order first and its reason (201) right
after: `modify()` does not take an echo that still shows the old quantity or price it changes, and
after an echo that cannot show the change (only an attribute changed) waits 500 ms for a refusal.
`orderMapping.ts` maps every attribute back into `WorkingOrder`, so lists, notifications and
"Modify" keep them. A modify whose good-after time ("HH:MM") is unchanged sends IB's own date and
time back (`sameGoodAfter`): rebuilt from "HH:MM" after that time has passed, it would hold an
already active order until the next weekday.

`previewOrder` (`orders.ts → preview`) sends the order without its bracket as a what-if under a
fresh order id and returns IB's estimate (`OrderPreview`); the what-if `openOrder`s never become a
working order. IB answers in parts (commission and notice, then margin, a few ms apart): they are
merged, and the answer is complete with the margin or 400 ms after the last part. Previews go one at
a time, an identical request within 10 s is answered from the previous one, and IB's answer is
awaited 8 s. It sends an order to IB, so it is refused while Tape is
locked (`LOCK_POLICY`).

### Notification sounds

Each OS notification plays the sound of its category (`shared/notificationSounds.ts`): orders
(kind `order`: submitted, modified, cancelled, rejected), fills (`fill`, partial fills too) and
other (`price`, `opt`, `conn`, `sys`). `settings.notifications.sounds` holds one sound id per
category; defaults are distinct per platform (macOS Tink / Glass / Purr; Windows the IM, Reminder
and Default sound events). A sound only goes with a notification that is shown: none when Tape's
do-not-disturb is on or the kind's system switch is off, and none with the Sound switch off or the
category set to None (`main/notificationSound.ts`):

| Platform | How the sound plays |
| --- | --- |
| macOS | The notification is `silent: true`; once it is posted (its `show` event, so not when notifications are not allowed) Tape plays `/System/Library/Sounds/<name>.aiff` with `/usr/bin/afplay` (`main/soundPlayer.ts`, one sound at a time). Electron 44 passes `sound` to `UNNotificationSound soundNamed:`, which does not look in `/System/Library/Sounds` (only the app's `Library/Sounds` and its bundle), and the notification daemon on current macOS rejects any name that is not one of its ToneLibrary tones, bundled files included; every category would play the default sound. Trade-off: the OS Focus modes and the per-app "Play sound for notifications" switch do not mute Tape's sound (Tape's own do-not-disturb and Sound switch do) |
| Windows | `toastXml`: the toast Electron would generate (ToastGeneric, title, body, the theme's icon file as app logo; XML-escaped) plus `<audio src="ms-winsoundevent:Notification.*"/>` or `<audio silent="true"/>`, played by the toast itself, so Focus assist applies. Electron still creates the toast with `id` / `groupId` and its event handlers: a body click (no `arguments`) emits `click`, so opening the instrument works as before. `Notification.SMS` is not offered (the default scheme plays the IM file for it); a saved one resolves to the category default |
| Linux | No choice: Electron's libnotify backend ignores `silent` and `sound`, so the notification server decides. Settings shows no per-category rows |

Every platform's ids pass the settings schema, so a profile copied between machines loads; an id
the running platform lacks resolves to its default for the category (`resolveSound`). The ▶ in
Settings › Notifications calls `testNotification(category)`: a sample OS notification of that
category with its sound ("Sound sample: …"), not added to the bell (do-not-disturb still wins);
the sample is closed after 6 s or when the next one is posted, so it does not stay in
Notification Center / Action Center looking like a real order or fill.

### TWS API client (`src/main/ib/tws`)

An in-repo replacement for the parts of `@stoqey/ib` Tape uses (same `IBApi` method names, event
names and listener arguments), built on `node:net` and `node:events` only.

* `connection.ts` — the socket, the `API\0` handshake offering server versions 176..193
  (`messageIds.ts`; TWS / IB Gateway 10.x) and length-prefixed frames of NUL-separated fields.
* `encoder.ts` / `decoder.ts` — requests and messages; `client.ts` is `IBApi`. Requests made before
  `nextValidId` are held and flushed after it. Every frame sent and received is also emitted as
  `sent` / `received` (the API log records them). A text field with a control character is refused
  (`checkFieldText`, an `error` event; nothing is sent): a NUL would split the field and shift the
  rest of the frame.
* `sendQueue.ts` — every frame goes through one queue: at most 45 messages per second (IB allows
  50), a burst of 10 and then spread evenly, halved for 10 s after IB's error 100. Lanes: orders,
  then control / account, then market data (FIFO per lane; market data that waited 1 s goes ahead
  of younger control frames). A cancel whose request is still unsent removes both.
* Wall Street Horizon: `reqWshMetaData` / `reqWshEventData` (conId or JSON filter, fill flags,
  date range and limit, always sent: every supported server version has them) and their
  cancels; the answers are `wshMetaData` / `wshEventData` (104 / 105) with IB's JSON as text.
* `pacing.ts` — per-request rules checked when a frame is written (the moment IB counts it):
  `reqMatchingSymbols` at most 1 per second; `reqHistoricalData` no identical request within
  15 s, at most 5 per contract + exchange + tick type within 2 s, at most 60 per 10 minutes
  (BID_ASK counts twice). A frame whose rule is full is passed over by the frames behind it.
  Services therefore do not pace these requests themselves.

### Database (`src/main/db`)

`ctx.db` (`db/types.ts`) persists caches of what IB would otherwise have to send again (bar series
in `bars`, JSON documents by namespace in `kv`) and what IB does not keep for the API (the
executions journal, the NAV history). It is `userData/tape.db`, opened with `node:sqlite` in a
worker thread (`worker.ts` → `server.ts` → `sqlite.ts`), so database work never blocks the socket
or IPC; the main side (`client.ts`) is an async RPC.

* Schema (`schema.ts`): `series` (`key`, `retention`, `last_access`, `bar_count`) + `bars`
  (WITHOUT ROWID, clustered by series and time), `kv` (`ns`, `key`, JSON, `updated_at`),
  `executions` (by `exec_id`, indexed by time), `nav` (`t`, `net_liq`). WAL; versioned migrations
  (v2 added `last_access`, set to the migration time, and `bar_count`, counted once; v3 replaced
  the `intraday` flag by the retention class `seconds` / `minutes` / `hours` / `daily`, taken from
  the bar size in the series key; every bar is kept).
* Writes never reject (best-effort, logged); writes that arrive together commit in one transaction.
  Reads reject on database errors.
* Series access: every `bars.get` / `bars.put` notes the series in the worker's memory; its
  `last_access` (unix ms) is written at most once an hour per series, in one transaction for all
  pending series when the worker is idle (and on close).
* Retention policy (`db/types.ts`), so the file cannot grow without bound:

  | Data | Kept |
  | --- | --- |
  | Seconds bars (1–30 secs) | 6 days (the cache serves 5: the newest session stays shown over a weekend plus a Monday holiday; about four sessions, 57,600 one-second bars each) |
  | Minute bars (1–20 mins) | 30 days |
  | 30-minute and hour bars (30 mins–8 hours) | 400 days, so a year of them (and a 1M range of 30-minute bars) stays cached; a series left empty (any of these) is removed |
  | Any series (in practice daily and longer) | Evicted with its coverage and head timestamp when not read or written for 90 days |
  | Size cap | Above 512 MB (`tape.db` + WAL), series are evicted until the data is under 80% of the cap: first those not used for 7 days (seconds, then minutes and hours, then daily; least recently used first), then the recently used ones, least recently used first (the chart on screen goes last) |
  | `kv` (contract details, option chains, coverage, head timestamps, the last market data check) | Entries not rewritten for 180 days are deleted |
  | Executions | Never deleted automatically (the trade journal is the user's record) |
  | NAV | All of it; compacted to one point per day after 10 days by `navHistory.ts` |

* Maintenance runs in the worker about 2 minutes after startup and then every 6 hours, once the
  port has been quiet for 5 s: retention deletes, the size cap, `PRAGMA incremental_vacuum` in
  steps, `wal_checkpoint(TRUNCATE)`, `PRAGMA optimize`. It is a generator of steps: one transaction
  deleting at most 5,000 rows (up to about 10 ms), or one `incremental_vacuum` whose page count
  follows the measured time of the previous one to take about 5 ms (a fixed 8 MB step took
  25–80 ms). The worker runs steps in slices of 20 ms, ending a slice before a step that would
  overrun it if it took as long as the one before, and reads its queue between slices: a request
  waits at most about one slice, and maintenance pauses until the port is quiet again. A series
  is evicted oldest bars first, its coverage and head timestamp (`kv` `coverage`, the head only
  when no other series of the contract shares it) with the first chunk; a series read or written
  again meanwhile is left alone.
* Evictions reach the main side as an `evicted` message before the worker reads its next request
  (`ctx.db.onEvicted`). The history service drops its in-memory coverage of those series (and
  deletes a coverage document it may have written from that copy in the meantime), so an evicted
  series is fetched again instead of being answered from bars that are gone. A load whose bar
  read was answered after the eviction while it held the old coverage (`pairedRead`) does not
  trust that coverage: the newest bars load cold, a page reads again.
* Settings › Market data › Local cache shows `getCacheStats()` (file + WAL size, series, bars,
  executions) and `clearMarketDataCache()` deletes bars, series and the `coverage` / `contract` /
  `secdef` namespaces (dropping and recreating `bars`: about 0.1 s for millions of rows, much
  faster than deleting them; requests wait for that statement), then returns the freed pages in
  the same vacuum slices, serving other requests in between (0.2–1 s of vacuum steps for a full
  cache), and answers once the space is back and the WAL truncated; executions and NAV are kept.
  Listeners hear `'all'` before the clear is sent.
* A corrupt or unreadable file is moved aside as `tape.db.corrupt-<ts>` and recreated; a file from a
  newer Tape version, or a worker that cannot start, falls back to the in-memory implementation
  (`memory.ts`, also used by tests). `close()` runs on quit.

### Historical bars

`market/history.ts` answers `getHistory` (the newest bars, a chart's window) and `getOlderBars`
(pages while scrolling back) from the bar cache, asking IB only for what the cache lacks (the
header of `history.ts` describes coverage, tails, paging and scheduling; `historyPages.ts` lists
what IB was seen to do). Intervals (`shared/timeframes.ts`, `historyParams.ts → TIMEFRAMES`):

| Interval | IB bar size | First window | Page (at most) | Retention |
| --- | --- | --- | --- | --- |
| 1s | 1 secs | 1800 S | 1800 S | seconds |
| 5s | 5 secs | 3600 S | 7200 S | seconds |
| 10s / 15s | 10 / 15 secs | 14400 S | 28800 S | seconds |
| 30s | 30 secs | 28800 S | 57600 S | seconds |
| 45s | 15 secs, merged | 14400 S | 28800 S | seconds |
| 1m 3m 5m 10m 15m | 1 / 3 / 5 / 10 / 15 mins | 2 / 5 / 10 / 10 / 20 D | 5 to 60 sessions | minutes |
| 30m | 30 mins | 20 D | 60 sessions | hours |
| 1h | 1 hour | 20 D | 6 M | hours |
| 2h 3h 4h | 2 / 3 / 4 hours | 3 M | 1 Y / 1 Y / 2 Y | hours |
| D, W | 1 day, 1 week | 2 Y, 10 Y | 2 Y, 10 Y | daily |
| M, Q, Y | 1 month (Q and Y merged) | 20 Y | 20 Y | daily |

* Every request stays at a few thousand bars and within IB's step limits (checked live: 1 secs
  refuses more than 2000 S with "invalid step"; 5 secs x 1 D took 15 s). Bars below a minute
  page in session seconds (`'N S'`, which IB counts in session time: a window asked for on a
  weekend, or before the 04:00 open, ends with the last session's bars, so the newest window ends
  at the newest stored bar; a `'1 D'` window would start at today's midnight and stay empty until
  the open); hour bars
  page in months and years. IB fills every bucket of a session (a bucket without trades is a flat
  bar at the previous close without volume) and nothing outside it.
* 45 s is the 15-second series merged into 45-second buckets on the epoch grid (New York midnight,
  04:00, 09:30 and 20:00 are on it); Q and Y are the monthly series merged into calendar quarters
  and years, stamped with their first day. The merged intervals share the cached series.
* 2, 3 and 4-hour bars lie on the UTC grid with a partial first bar at the session open; seconds,
  minutes and 1 hour on New York's (the same epoch grid).
* Pages of bars of 30 seconds or less stop six months back (`HistoryPage.limited`, IB's documented
  limit; this paper account served older ones, but paging that far is not worth IB's 60 requests
  per 10 minutes) and the chart says so. IB's small-bar pacing is kept by the send queue
  (`pacing.ts`); the chart reloads every intraday interval every 60 s (10 of IB's 60 requests per
  10 minutes, beside the 40 pages may use).
* The v3 schema migration moves series to retention classes by bar size and drops the coverage of
  those that now stay longer (hours): the old coverage may claim bars the old 30-day maintenance
  had deleted. Their bars stay and are claimed again on the next load.

In the renderer (`features/chart`), `chartPrefs.ts` keeps the interval (one for all instruments),
the active range and the favorites (toolbar chips) in `localStorage`; preferences saved before
the picker keep their interval (the daily and longer keys stay `1D` … `1Y`). `TimeframeBar.tsx` is
the picker; the toolbar shows the favorites that fit its width (the rest stay in the picker, and
an active interval or range without a chip shows on the "▾" button). A range (`ranges.ts`: 1M →
30m, 3M → 1h, YTD and 1Y → D, 5Y → W, Max → M; 1M and 3M take 1h / 2h and 2h / 4h when the plot
is too narrow for 1.25 px a bar; YTD takes a finer interval in the first weeks of January) loads
its span with pages sized to what is missing (Max until IB's head timestamp; a refused page is
asked again after its wait) and fits the view to it (up to 1,200 bars per screen) until the user
pans or zooms. Between reloads a real-time last price extends the forming bar and starts the next
ones on the interval's grid (`chartMath.ts → advanceLiveBars`); the live bars are kept between
quotes until a reload reaches them, nothing is filled across the overnight break (the first bar
starts at the 04:00 open), and delayed quotes (the account's market data type 3 / 4) never touch
intraday bars, and seconds charts show a note. A reload of a seconds window, which slides with
every reload, replaces the chart's bars unless older pages were loaded in front of it.

### Quote subscriptions

Components call `useQuoteSubscriptions(owner, contracts, profile)`, which sends the owner's full set
with `setQuoteSubscriptions(owner, subs)` (an empty set releases it; the renderer drops quotes no
owner wants any more). `market/quotes.ts` unions the owners per contract (`subscriptions.ts`), keeps
one `reqMktData` line per contract whose generic tick list is the union of the owners' profiles
(`basic`, `underlying`, `option`, `dividends`), and cancels lines nobody wants. At most 95 lines are open (IB's
default limit is 100), in the order the contracts were first wanted; the rest carry a "line limit"
error on their quote. Price alerts are an owner too. After every handshake and after 1101, market
data type 4 (delayed-frozen fallback) is set and all lines are requested again.
Errors after which IB dropped a line end it; 10197 (competing live session) keeps it open and is
shown on the quote and the connection. Quote changes reach the renderer as `quotes` events batched
every 100 ms. The `dividends` profile adds generic tick 456 to stocks: IB answers with tick 59
("past 12 months, next 12 months, next ex-date, next amount", e.g. `3.64,3.92,20261119,0.98`),
kept as `Quote.dividends` (an empty object for IB's `,,,`: no dividend). IB sends it only on live
lines; a delayed line (market data type 3 / 4) never gets it. The `underlying` profile of stocks
includes 456 too, so the stock tick lists nest (basic ⊂ dividends ⊂ underlying): a line already
open for a stock is requested again once with the wider tick list and then kept when a page with a
narrower profile takes over (options view ↔ dashboard).

The Level 2 book (`market/depth.ts`) uses one depth line at a time (IB allows 3 per
account, TWS and other clients included); the market data check may hold one more for a few seconds
(`DepthService.openLine` / `closeLine`). IB can take 10 s and more to start a depth stream (SPY SMART
depth, seen live: first updates after 6–13 s), and a `cancelMktDepth` that arrives before the stream
has started is ignored: the stream starts anyway, a later cancel answers 310, and the line streams
unheard and holds one of the account's 3 until the session ends. So `depth.ts` cancels a line only once
it has answered (a book update or a 317 reset): a line released before that is cancelled on its first
update, dropped on an error that ended it, and cancelled anyway 60 s after the request
(`CANCEL_CAP_MS`). A 309 for the view while another line of this client is open or being cancelled, or
right after a cancel, is retried once, when those lines are gone.

Main-process owners in `subscriptions.ts → QUIET_OWNERS` (the market data check, `md-check`) get lines
like any other owner, but a contract only they want is never sent to the renderer. `probe()` opens a line
outside the owners (the check's primary-exchange line); probes and fallback side lines count against the
95-line budget like owner lines, and a contract that finds no free line while they are open carries the
line-limit error until they close (closing a probe or a side line reconciles again). Side lines only take
free lines, never a lingering one. A contract that changes from "quiet owners only" to "published" (a
renderer owner joins) is reconciled, which sends its quote to the renderer at once.

#### Primary-exchange fallback

IB may send an account a stock's SMART (consolidated) quote delayed while the stock's own exchange sends
live data with the same subscriptions (paper account DUP899854, pre-market: AAPL on SMART type 3 by symbol
or conId, with or without `primaryExch`, 10168 with type 1 requested; on NASDAQ type 1; NVDA, MSFT, SPY …
type 1 on SMART). For SMART-routed US dollar stocks `quotes.ts` keeps a route per contract:

```
smart ──delayed (type 3 / 4, 10167, 354, 10168)──▶ side line on the primary exchange
  side: type 1 / 2 ──▶ primary: the side line becomes the quote's line, the SMART line is cancelled,
                       quote.source = { kind: 'primary', exchange }
  side: type 3 / 4, 10167, an error, nothing in 10 s ──▶ stay on SMART; no probe for 30 min, then one
                       if the line is still delayed
primary ──every 10 min; at once when a 10197 episode ends──▶ side line on SMART: type 1 / 2 → back to
                       SMART (exchange line cancelled, source cleared); otherwise next retry in 10 min
primary ──the exchange line turns delayed──▶ side line on SMART: live → back to SMART; delayed → back to
                       SMART anyway (the side line becomes the line); an error or nothing in 10 s → a new
                       SMART line; then no exchange probe for 30 min
handshake (reconnect, 1101) ──▶ every line starts on SMART again
```

A 10197 episode starts only on an owner line (a side line's 10197 is a failed probe) and ends with a live
(not delayed) price on a line that reported it, at most once a minute (`COMPETING_END_MIN_MS`), so a
competing session never makes delayed stocks open side line after side line.

Two things outlive a contract's route, which goes with its line (a stock left for 30 s): the give-up
times (a stock wanted again within its 30 min does not probe its exchange again; they end with a new
session) and the fallback's findings (`QuoteService.fallbacks()`: stocks found SMART delayed and live on
their exchange, kept across reconnects, cleared when the account changes; an entry goes when SMART
answers live or the exchange delayed). The market data check reports the findings.

The primary exchange comes from contract details (`primaryExch`); IB serves market data directly on the
codes it reports (checked live: NASDAQ for AAPL, NYSE for IBM, ARCA for SPY, AMEX for IMO, BATS for CBOE;
`US_PRIMARY_EXCHANGES`). The side line has the line's generic ticks; its ticks are held until it wins and
then applied. A side line lives at most 10 s, so the steady state holds one line per contract; a line
re-requested for new profiles stays on the exchange; lingering lines are not probed. The renderer marks
such quotes by their data type: the chart header and the watchlist row read "Live · NASDAQ" ("Delayed ·
NASDAQ" for delayed data), the order ticket shows "Live · NASDAQ: NASDAQ's own bid/ask, not the
consolidated quote (NBBO)" under its bid / ask, and the tooltips name the stock.

### Market data check

`market/marketCheck.ts` answers "what does this account get?" by asking IB rather than reading the
quotes on screen. A check (`checkMarketData`, or `ctx.marketCheck.run`) holds streaming lines
(`reqMktData` with snapshot and regulatory snapshot off: regulatory snapshots cost money) for a few
seconds:

| Market | Lines | Result |
| --- | --- | --- |
| US stocks | SPY via the `md-check` owner (SMART) and a probe on SPY's primary exchange (ARCA) | SMART's status; live "via" the exchange when only that line is live; the stocks the fallback found SMART delayed and live on their exchange this session (`fallbacks()`, also when their line has gone) |
| US options | an option line a view already holds with an answer, else the SPY call of the first expiration after today with the whole strike nearest SPY's price (chain → contract details) | its status |
| Indices | SPX on CBOE via the owner | its status |
| Level 2 | only on *Check now*: the depth view's book when it has levels, the depth view's open line (its first answer) when it has none yet, else one depth line of its own (SPY, SMART depth, 5 rows, `DepthService.openLine`), released when it answers | live on the first update; "via" the exchanges IB's 2152 lists when it lacks others; 309 / 10092 / 354, or no update within 20 s (`DEPTH_TIMEOUT_MS`), no data |

Contracts another owner holds, or whose line lingers, answer at once from their quote (their type or
error; nothing is requested). Otherwise a line's answer is its `marketDataType` (1 live, 2 frozen, 3 / 4
delayed) or its error, watched 1.5 s after the first answer (10197 may follow a type), 4 s after a 354
(with type 4 set IB often serves delayed data on the same line: SPX answered 354 and half a second later
type 3 and 10167); no answer in 8 s is no data. 10197 overrides everything (nothing flows). Tape's own
outcomes carry code −1 and `own`: `timeout`, `lines` (no free line), `closed`, `contract` (no option
found). A session that closes midway fails the check and keeps the previous result.

IB may send the 2152 of a depth request seconds after the first book update (seen live: 12 s after the
request, after the cancel). The depth line is therefore watched on: for a 2152 15 s from the request and
at least 10 s from the first update (`DEPTH_NOTICE_MS`, `DEPTH_LATE_NOTICE_MS`), and after a timeout for
a first update or an error until the depth service's cancel cap. Each later answer patches the stored
result (persisted and pushed again). Until then the account's previous 2152 stands; when none comes it
is dropped. The check's own depth line is released when it answers; the depth service cancels it once
IB has started it (see Quote subscriptions), so a slow start never leaves it streaming.

The Level 2 switch (`settings.features.depth`: the Trade page's Depth tab and the floating ticket's
book) is off by default, since an open book uses one of the depth lines IB allows per user (3 by default,
shared with TWS and other API clients; 309 when none is free) and an exchange-limited book (IEX only) can
mislead. `features.depthSetByUser` records that the user set it in Settings › Market Data
(`logic.ts → depthSwitchPatch`); until then the final Level 2 answer of a check turns it on when it is a
full book (live with no code at all, `shared/depthPermissions.ts → isFullBook`,
`marketCheck.ts → turnsDepthOn`). Since nothing turns the switch off by itself, the answer has to be
final: a book without a 2152 is watched on for one until 60 s after the request and at least 30 s after
the first update (`DEPTH_FINAL_MS`, `DEPTH_FINAL_AFTER_UPDATE_MS`, well past the window above) and is
stored `unconfirmed` meanwhile; a 2152 then still patches the result and keeps the switch off. Only a
2152 counts as a partial book: other 21xx notices on the line neither end the watch nor stand for a full
book. When the watch is over (`DepthAnswer.settled`) the switch follows only the latest Level 2 check, and
only while its answer is still the one shown (a check without Level 2 keeps it; a newer Level 2 check
replaces it). A session that closes, or IB dropping the market data requests (1101: the connection fires
ready again), before the watch is over decides nothing and leaves the answer `unconfirmed`, as do the depth
view's book (whose 2152 its next update clears) and demo. Settings saved before `depthSetByUser` existed
count Level 2 on as the user's choice (`storeSchema.ts → loadSettings`; it was off by default) and lose
the removed `features.options` / `features.flow`: the Options view and the desk's Flow tab are always
there (option quotes work delayed without OPRA, and the flow comes from the chain quotes on screen).

The result (`MarketDataCheck`: account, client id, trigger, per market status, both probes, codes and
messages, the time) is kept in main, persisted in `kv` (`mdcheck` / `last`, not cleared with the market
data cache) and pushed as `marketDataCheck` events (`running`, and `depth` while a check with Level 2
runs; snapshot field `marketDataCheck`). A
check without Level 2 keeps the previous Level 2 answer of the same account. Concurrent calls join the
running check; a request with Level 2 during one without runs right after it. A quiet check (no Level 2)
runs 8 s after every handshake unless one ran for the account in the last 5 minutes.
`checkMarketData` is refused while locked (`LOCK_POLICY`: a user action that sends requests).

Settings › Market data (`MarketDataSection.tsx`, `logic.ts → checkNeeded / checkItems / checkReasons`)
shows per market the checked status ("Live", "Live · NASDAQ only", "Delayed", "No data", "Frozen (market
closed)"), the instrument with the SMART / exchange split or IB's code, "checked 2 min ago", the quotes of
this session as a second line, and one note per reason: a competing session (10197), no live data for the
markets it names (354 / 10089 / 10090 / 10091 / 10167 / 10168 / 10186 or plain delayed data; for a paper
account the market data sharing setting, which takes up to a day, only when no market of the check is
live), SMART delayed but the exchange live (per stock and exchange; "in general" only when the check's own
SPY was delayed on SMART), a missing or partial depth subscription (2152 lists the exchanges), no free
depth line (309), no answer, no free line, no option found. Opening the section checks again when the
result is older than 5 minutes or belongs to another account; *Check now* includes Level 2. While not
connected the last result stays, muted, with "not connected". Under the Level 2 switch (sub-section
"Market Depth"), next to the check's tag, `logic.ts → depthNote` says what the check found: the books of
some exchanges only (the subscriptions they need are in the 2152 note above), no free depth line, no book
(a subscription answer, or none at all), a book not confirmed yet, turned on by this check or an earlier
one, a full book, or, not checked, the subscription Level 2 needs.

### Corporate events

`getEarnings(underlyings)` (`market/corporateEvents.ts`) asks Wall Street Horizon for the
holdings' earnings from today to 90 days ahead: `reqWshMetaData` once per connection (IB wants it
first), then one `reqWshEventData` per conId, one at a time, cached per conId for the New York
day. Option-only underlyings are resolved to their conId first. The answer has a status: `ok`,
`unsubscribed` (IB refused with 10276 "News feed is not allowed" or 10277: the account has no WSH
subscription, as on the paper account; remembered until the next handshake, so IB is not asked
again) or `unavailable` (not connected, a timeout or another error). IB documents the event JSON
only by example and the paper account cannot receive any, so `parseWshEarnings` reads it
defensively (an array, `{ events }` or arrays keyed by event type; earnings types `wshe_ed` /
`earnings`; yyyy-mm-dd or yyyyMMdd dates; before / after the session); an answer it cannot read is
logged once. Dividends do not come from WSH but from the dividend tick above.

### API log

Every frame is recorded raw in a ring of the newest 20,000 (`ib/apiLog.ts`) and, when enabled,
appended to `api-YYYYMMDD.log` (local day) in the logs folder; entries are decoded only when read.
Live `apiLog` events are sent only while a view streams them (`STREAM_BY_DEFAULT = false`):

1. A view (Settings › API log, the Connection mini log) mounts and `useApiLogStream` calls
   `setApiLogStreaming(true)`, then `getApiLog()` once that has resolved.
2. Batches (every 250 ms) carry every frame recorded after streaming started, so they can overlap
   the loaded entries; the renderer keeps entries by `seq` (`bridge.ts → appendLog`,
   `withLoadedLog`), so nothing is missed or duplicated.
3. Each batch carries `logFilePath`, today's file, so the view follows the date change at midnight;
   a stream start sends one even without frames.
4. Streaming is tracked per renderer (`createLogViewers`, keyed by webContents): the last view to
   unmount turns it off, and a reload (`did-start-loading`) or a destroyed window ends it too.

### Lock screen (`src/main/lock`)

Main is the only authority on whether Tape is locked; the renderer draws `LockState` (snapshot field
`lock`, then `lock` events) and asks to unlock.

* `service.ts` — `createLockService`: `locked` starts true whenever a PIN exists, so a relaunch does not
  bypass the lock. PIN checks are serialized. `verifyPin` / `verifyBiometrics` hand out a single-use token
  (5 minutes) that `setPin` (once a PIN exists) and `removePin` require; biometrics only count (to unlock or
  to change the PIN) when *Unlock with* is Touch ID / Windows Hello. The wrong-PIN counter is applied in
  memory first and persisted best-effort (a disk that cannot be written neither disables the backoff nor
  blocks the right PIN), and each wait also has a monotonic deadline (`performance.now`), so moving the
  system clock forward does not end it.
* `pin.ts` / `lockFile.ts` — the PIN rule is shared (`@shared/lock`: 6 code points after NFC, no whitespace or
  control characters). `userData/lock.json` (mode 0600, written atomically and synchronously) holds the
  scrypt record (random 16-byte salt, N 2^15, r 8, p 1; compared with `timingSafeEqual`), the count of
  consecutive wrong PINs and the next allowed time: 5 free attempts, then 30 s doubling to 15 minutes. It is
  never part of Settings and never reaches the renderer; a retry time is capped at now + 15 min, so a clock
  set back cannot lock the user out longer. Reading fails closed: only a missing file or `"pin": null` means
  "no PIN". A file that cannot be read (after a few retries for EBUSY / EPERM …), is not JSON or holds an
  unknown record is `unreadable`: Tape starts locked, every check answers `pinUnreadable` (the lock screen
  points to Forgot PIN, which deletes the file), the file is re-read on each attempt and never overwritten.
* `idle.ts` — every 15 s, locks when `powerMonitor.getSystemIdleTime()` (system-wide input) reaches the
  configured minutes (`settings.lock`). A tick that comes late (the machine slept; the wake-up key press
  resets the system idle time) adds the gap to the idle time seen at the previous tick; `suspend` /
  `resume` run a check too. Nothing happens without a PIN.
* `biometrics.ts` picks the provider (`types.ts → BiometricProvider`): `touchId.ts`
  (`systemPreferences.canPromptTouchID` / `promptTouchID`), `windowsHello.ts`, none on Linux, or a fake one
  from `TAPE_FAKE_BIOMETRICS` in development. Availability starts as `checking` and is asked when Settings
  opens, and — only with a PIN and *Unlock with* biometrics, since Windows Hello's check starts a PowerShell
  helper — at launch, on resume, on lock and when the lock screen opens; `prepare()` (the warm helper) also
  runs only then. An answer that arrives after the provider was disposed (unlocked with the PIN) is dropped. The prompt only opens on an explicit click; every rejection is "not verified", never
  "Incorrect PIN".
* While locked: `ipcDispatch.ts` refuses every method whose `LOCK_POLICY` (`src/shared/ipc.ts`, one entry
  per method, so new methods must be classified) is `deny` with `LOCKED_MESSAGE`. Allowed: the snapshot,
  data feeds that mounted views keep using (quotes, depth, history, contract info, option chains,
  earnings, executions refresh), the cache size poll, API log streaming, `notify` (the option risk watcher) and the lock methods. The order
  service checks the lock again before sending (also after its contract lookup). The menu disables its
  custom items except *Lock Tape*; notification clicks only show the window; on Windows / Linux the
  caption buttons take the lock screen's background (`Appearance.setLocked`; restored ~1.1 s after the
  unlock, when the renderer's animation has played). Handlers that wait for the user (the API log's save
  dialog) check the lock again afterwards. Scripted captures (`devCapture.ts`) never run in a packaged app. IB stays connected; alerts
  keep running in main.
* Renderer: `features/lock/LockScreen.tsx` sits above everything (z-index 40) while the app under it is
  `inert`; `state/lockActions.ts` closes dialogs, the bell, popovers and drops a pending order review when
  locking, and collapses floating panels to their bars (they stay collapsed after the unlock); a capture key listener (`features/lock/actions.ts → installLockKeyGuard`) keeps every shortcut
  from running and sends typed keys to the PIN input. The store's `unlocking` keeps the screen up while the
  unlock animation plays after main has already unlocked.

**Forgot PIN → Reset** (`reset.ts`) runs in two phases, so nothing still running can write a file after it
was deleted (pending JSON writes, window bounds, API log appends, the SQLite worker; Windows refuses to
delete open files):

1. `resetApp(word)` (allowed while locked) checks the word (RESET / 重置), writes `userData/reset-pending`
   with the language and theme, disconnects, closes the database (each bounded to 1.5 s), then
   `app.relaunch()` + `app.exit(0)` (no before-quit, so nothing is flushed). Development and capture runs
   exit without relaunching; their next launch finishes the reset.
2. The new process, only when it holds the single-instance lock and before any service opens a file,
   deletes Tape's own files by name (the JSON documents with their corrupt backups and temporary files,
   `lock.json`, `tape.db` with WAL / SHM and corrupt copies, the `api-YYYYMMDD.log` files in the log
   folder) and writes `settings.json` with the kept language and theme. After ready it clears the renderer
   storage (`session.clearStorageData`, `clearCache`) and removes the marker last, so a crash midway resets
   again. The first snapshot has `afterReset`: Settings › Connection opens and this launch does not
   auto-connect. Files that could not be deleted are listed in a notification. The folder itself is never
   removed: Chromium's files and the single-instance lock live there.

## Renderer

* `src/renderer/src/state/store.ts` — mirrored main state + cross-feature UI state (page, current
  instrument, order ticket, dialogs). Feature-local UI state stays in the feature.
* `src/renderer/src/features/<feature>/` — one folder per feature. Each feature declares its own
  strings with `createMessages({ en, zh })` (see `src/renderer/src/i18n/index.ts`).
* `src/renderer/src/ui/primitives.tsx` — controls that reproduce the design (Toggle, Segmented,
  Chip, TabItems, TextInput, Button, Modal, KeyValueRows, Popover, MenuItem).
* Design tokens are CSS variables in `styles/tokens.css`. The root element carries
  `data-th` (dark | light), `data-sk="a"` and `data-cv` (cn = red up, us = green up).
  Always use `var(--up)` / `var(--dn)` for price direction, never raw red/green.

### Order ticket (`features/ticket`)

The ticket keeps the design's simple form: five order types, quantity and price, TIF, and a
collapsed "Advanced" section. Everything else is one step away:

* **More ▾** opens the other order types grouped as touched, trailing, auction (with market / limit
  on open as MKT / LMT + OPG), midpoint & pegged, and other; each with IB's code and a one-line
  hint. A chosen one is described under the type row, and its price fields replace the main ones
  (trigger, trail with initial stop and limit offset, optional cap, offset by amount or percent).
* **Advanced** keeps the trading session on top and puts the rest in collapsible sections that sum
  up what is on when closed: take profit / stop loss (stop-loss type and adjustable stop),
  conditions (up to five rows of price, time, % change, volume, margin cushion or execution, joined
  by and / or; submit or cancel when met; incl. extended hours), fill (all or none, minimum
  quantity, hidden, sweep, discretionary, iceberg, forex amount), trigger method (stops and touched
  orders only, filtered by instrument), IB algo (offered per instrument, with a parameter form from
  `orderRules.ts → ALGOS`), routing & OCA, good-after time and note. The toggle line lists what is
  on ("Advanced · Extended hours · TP/SL · AON · Adaptive").

The ticket's state, rules and submit flow are one controller (`useTicket.ts`); `parts.tsx` holds its
parts (quote boxes, side, order types with the More menu, quantity, price, TIF, Advanced, totals, submit)
with a size scale. The docked ticket (`OrderTicket.tsx`, `DOCKED_SCALE`: the design's column exactly) and
the floating ticket (`features/panels/TicketFloat.tsx`) lay out the same parts.

`buildOrder.ts → composeOrder` turns the ticket into a request (always, noting the first problem);
`buildOrderRequest` refuses a problem and then runs `orderProblems`. The same composed request
decides what is greyed out: `choiceProblem(input, patch, field)` composes the ticket with the choice
applied and returns the first rule problem involving that field (`problemsInvolving`), ignoring
values still to be typed (a group name, an algo parameter). The ticket's current combination
problem is shown in red under the TIF row. The contract's `orderTypes` and `validExchanges`
(`useContractInfo`) feed the rules.

"Modify" (`orders/model.ts → ticketPatchFromOrder`, used by the Orders page and the chart's
activity panel) loads every attribute of the working order into the ticket and opens the sections
it uses; a modify sends switched-off attributes explicitly (false / 0 / ''), since IB replaces the
whole order. What IB does not change on a working order is locked with the reason: side, order
type, algo (its parameters stay editable), OCA group, conditions' kinds, operators, joins and mode
(their values stay editable), destination, adjustable stop, trigger method, sweep to fill, a
relative order's offset mode, switching off a discretionary amount or good-after time the order has,
and session / TIF as before; orders sized by cash are not offered for "Modify".

The review (`layout/Dialogs.tsx`) lists every chosen attribute (`orders/attributes.ts`, shared with
the lists, the cancel dialog and the CSV) and, for new single-instrument orders while connected,
IB's estimate from `previewOrder`: asking, then commission, initial and maintenance margin change
(before → after), equity with loan and IB's notice, or IB's refusal in red. Sending never waits for
it.

### Floating panels (`features/panels`)

The order ticket (Trade › Chart and Depth, 340px column) and the options strategy builder (Trade ›
Options, 384px) have a pop-out icon at the top right of their header. It turns the panel into a
floating panel inside the main window; the column goes and the chart, depth or chain takes the full
width. The panel's dock-back icon puts it back in its column with the same state (the state lives in
the stores; nothing is copied). There is no separate OS window and no setting.

**Layer.** `FloatingPanels.tsx` (mounted by `App` over the content area under the top bar, inside the
`inert` app root) is an absolutely positioned layer that passes clicks through; its z-index (1) puts the
panels above the page content and below menus and popovers (4+), the top bar and its dropdowns, the
notifications panel, dialogs, toasts and the lock screen. The panels are non-modal: everything around
them stays usable. The ticket shows where the docked ticket would (Trade › Chart, Depth), the strategy
builder in Trade › Options (`actions.ts → panelShown`).

**Frame** (`FloatingPanel.tsx`, geometry in `model.ts`, pure and tested). The popovers' elevation (1px
`--ln` ring, popover shadow). A 36px header is the drag handle, with the title (ticket: "Order · AAPL",
name and primary exchange, last price and change, the session; strategy: "Strategy · AAPL", the
strategy and its expiry) and two controls: collapse ▾ and dock back. Eight handles resize it from every
edge and corner (pointer capture; the opposite edges stay put), between a minimum (about the docked
width × 420px; shorter content scrolls) and the content area less an 8px margin. The first time it
opens at 1000 × 625 (16:10) over the right part of the content area under the view tabs, smaller in a
small window. Pressing in the panel focuses it (`tabIndex=-1`), so its keys work: Esc in a field leaves
the field (focus goes to the panel), the next Esc collapses the panel (dialogs and menus take their Esc
first; `panelKeyAction`). With nothing focused, Esc still collapses the panel the user last worked in
— pressed in, or expanded by B / S, Modify or a quote — until they press somewhere else
(`shortcuts.ts → escapePanel`). The ticket's ⏎ / ↑ / ↓ / B / S work as docked (`useTicketKeys` treats
the focused panel like the page); ⏎ does nothing while the last order still waits for IB.

**Persistence** (`panelStore.ts`, localStorage `tape.floatingPanels`, read and written in try/catch):
per panel `floating`, `collapsed`, the expanded rectangle and the bar's position, relative to the content
area. They are fitted into the area whenever it is drawn (`panelRect`, `barRect`), so a smaller window
moves a panel inside without forgetting where the user left it; a panel floating at quit floats at
launch.

**Layout.** The content lays itself out for the panel's own width (never the window's,
`layout.ts`): below 900px the docked panel's single column (the same component with the panel header
and the status strip); from 900px three columns that scale up a little from 1240px (narrower, the
ticket's ask box and More, and the strategy's leg descriptions, would be cut). Ticket
(`TicketFloat.tsx`): market (bid / ask boxes, a click fills the limit price; 5 levels a side of the book
when the depth feature is on and IB sends one, sharing the single depth line with the depth view through
`state/depthSubscription.ts`; the position valued as on the Portfolio page; the instrument's working
orders with Modify / Cancel), entry (side, order type and More, quantity with 100 / 500 / 1K / Position,
price ± one tick with Bid / Mid / Ask on the tick — the mid rounds to the passive side, `quickActions.ts`
—, TIF, the trading session; "Modifying #1234 · Cancel modify" on top while modifying), confirm (the
Advanced sections as one-line rows that scroll, then fixed: the status strip, totals, IBKR's what-if
margin and commission — asked 600 ms after the ticket changes, not on price ticks — and the submit
button). Strategy (`StrategyFloat.tsx`, its own model and quote owners in
`options/strategyPanelModel.ts`): legs (template, the legs, "+ Add from the chain", net greeks), a
large expiry P&L chart with the statistics, and the order (net price ± a cent, `deskStore.netPrice`,
dropped when the legs change; type, TIF, condition, estimated cost, strip, send).

**After a submit.** An order sent from a floating panel carries its `origin` (`PendingOrder.origin`)
and reports through `state/orderFeedback.ts` instead of toasts: the button reads "Submitting…" and is
disabled until IB answers; the review dialog (when enabled) works as before. The status strip
(`OrderStrip.tsx`, `stripModel.ts`) shows "Submitted #1234" / "Modified #1234", the order line and IB's
live status: pre-submitted / working → partially filled with progress → filled with the average price,
the position change and the commission; cancelled; or IB's rejection in red (also the late Inactive /
201 case) with "Fix and resubmit" — the form keeps its values. Inline Modify / Cancel while it works;
× dismisses it; the next order replaces it. The new order flashes at the top of the working orders. An
accepted order (placed or modified) always collapses the panel to its bar; a rejection keeps it
expanded, and a late rejection expands a panel its order collapsed. The docked panels keep their
toasts.

**Collapsed bar** (`CollapsedBar.tsx`): about 420 × 40 with the drag handle (symbol and last price;
strategy: name and net price), the latest order's status ("Buy 100 · 60/100", "Filled"), Buy / Sell
(ticket) and ▴. A click on the bar (without dragging) or the chevron expands it, as do ⏎ on the bar, B /
S (`shortcuts.ts`, with that side), Modify (orders list, activity panel, the strip), a depth level and a
chain quote (`actions.ts → openTicket`, `revealPanel`); docked, those actions behave as before. "+ Add
from the chain" shows the chain and collapses the strategy panel until a quote is picked. The bar has its
own remembered position (first: the bottom-right corner of the content area).

### Portfolio dashboard (`features/portfolio/dashboard`)

The Dashboard tab is a 3-column grid of widgets the user arranges in edit mode.
`layout.ts` is the catalog (ten widgets with their default spans; the default layout shows all of
them) and the pure edits (move into the drop target's place: before it when dragged backwards,
after it when dragged forwards, or to the end on the "Add widget" tile; S / M / L span, remove, add
at the default span); `layoutStore.ts` keeps the layout per device in `localStorage` `tape.dash.v1` (an array of
`{ id, span }`, read and written in try/catch; unknown ids dropped, a missing or invalid value is
the default, Reset removes the key). Edit mode, the catalog and a drag are not persisted, and
locking ends them (`state/lockActions.ts`).

Every figure is the account's own (`model.ts`, pure; `data.ts`, the hooks):

| Widget / header | Source |
| --- | --- |
| Market Value | The position rows' values of stocks and options (the one-price rule), IB's stock + option market values when a row has none (`calc.ts → accountTotals`; account updates' `StockMarketValue` / `OptionMarketValue`, which paper accounts send only as `$LEDGER-…` keys, read from their `BASE` row, `account.ts → accountValueField`) |
| Realized Today | `reqPnL`'s realized P&L, else the sum of today's executions' realized P&L (since New York midnight) |
| Excess Liquidity, margin cushion | `ExcessLiquidity` / `NetLiquidation` (the fraction IB's account-updates `Cushion` value holds, computed from the summary values the dashboard already has); red below 10 %; leverage = gross position value / net liquidation |
| Portfolio greeks | IB's per-share model greeks (tick 13) of each option × quantity × multiplier, stocks count their shares; totals are "—" while an option still waits for its greeks; dollar delta at the option's model underlying price, else the underlying's quote |
| Concentration | Σ \|value\| per underlying (stock and options) / net liquidation, flagged from 20 % |
| P&L contributions | The rows' re-marked day P&L, largest first |
| Option expirations | Days to expiry (local calendar) and moneyness from the underlying price (futures options: only IB's model underlying price, never their own premium) |
| Today's trades | `executions` since New York midnight (`shared/session.ts → nyDayStart`, re-checked every minute: main keeps the session's fills, so after midnight the list still holds yesterday's) |
| Earnings & dividends | `getEarnings` (Wall Street Horizon, needs IB's subscription) and `Quote.dividends` (tick 456, live lines only); the note says when earnings dates are missing (not subscribed, or unavailable while connected) |
| vs. benchmark | The equity card's range return against SPY / QQQ: live price over their price at the range's first NAV sample, so both start at the same moment. A start within 9 days is priced from 5-minute bars, within 25 days from hourly ones (the close of the last bar that ended by then, else the open of the bar it falls in); an older one, or one the intraday window misses, at the daily close (16:00 New York) at or before it (older pages for long ALL ranges). Bars through `getHistory`, regular hours |

The hooks subscribe only while their widget is on the layout, under their own quote owners:
`dashboard-und` (option underlyings, basic), `dashboard-div` (the holdings' stocks, `dividends`)
and `dashboard-bench` (SPY, QQQ). Option greeks need no line of their own (the `portfolio` owner
subscribes every position).

### Watchlists

Lists of groups of instruments, persisted by the main process in `watchlists.json`
(`storeSchema.ts → sanitizeWatchlists`). The built-in lists (Watchlist, Indices) cannot be deleted
or renamed: a missing one is restored and their name comes from the defaults, but their groups are
the user's and saved as edited. The renderer edits them with the pure functions of
`features/watchlist/model.ts` and commits the result (`actions.ts`).

* Groups are renamed and deleted from their header (✎ / × on hover or keyboard focus, or the
  right-click menu). Names are trimmed and unique within a list, ignoring case and counting both
  languages of a localized built-in name; a renamed built-in group gets a plain string name.
* Deleting a group removes its symbols (confirmed when it has any); a list keeps at least one
  group. The panel's `watchlist` quote owner is the current list's instruments, so the removed
  symbols' quotes are released with the next subscription set.
* The current list and the collapsed groups are per-device preferences in `localStorage`
  (`prefs.ts`); collapsed entries of groups the list no longer has are dropped.
* Name editors closed with Enter / Escape and a group deleted from its header give focus back to
  a ✎ (the group's own, or the group now in its place) or to "+ New group" / "New list"
  (`ui/focus.ts → useRefocus`). Focus left on `<body>` would let the next Enter submit the
  order ticket (`useTicketKeys`).

### Time format

Settings › General › Time format (`settings.appearance.timeFormat`: `'12h'`, the default, or `'24h'`)
decides how every clock time a person reads is written. `src/shared/timeFormat.ts` is the one
formatter, pure and used by both processes:

* `createClock(format, lang)` returns a cached `Clock`: `time(t, { seconds, timeZone, zone, date })`
  for instants ("9:41 AM", "上午 9:41:07", "10/09 4:00 PM ET", "09:41"), `wall('16:00', { zone })` for
  24-hour wall times as IB and the ticket keep them, `range()`, and `parts()` (digits and period apart,
  for the lock screen). 12-hour Chinese puts 上午 / 下午 first; midnight is 12:00 AM / 上午 12:00.
  The renderer gets the user's clock with `useClock()` (re-renders on a change, so open views follow it
  live) or `currentClock()` outside React (`i18n/index.ts`). Model functions take the `Clock` as an
  argument; shared helpers that predate it (`orderTiming.ts → timingText`) default to `CLOCK_24H`.
* `parseTypedTime(text, format)` reads what users type in either format ("9:35 AM", "下午 9:35",
  "09:35", "21:35") into 24-hour "HH:MM" (the good-after field stores that and shows it in the chosen
  format). On the 12-hour clock an hour of 1–11 without a leading zero and without AM / PM ("3:55") is
  ambiguous and rejected rather than read as morning. The good-after field does not filter text while
  an IME composes (pinyin for 上午 / 下午). Tables of clock times size the column with
  `timeColumn(clock)` and keep the cells on one line. Native
  `datetime-local` inputs (GTD expiry) follow the OS; texts that echo their value use the clock.
* Stored texts: notification titles and bodies are built once but read later, so their times are
  tokens (`TOKEN_CLOCK` writes "⟦t:<ms>:<flags>⟧"); `resolveTimeTokens` writes them in the current
  format when the bell list draws them and when main shows the OS notification.
* Not affected: the API log (milliseconds), CSV exports and everything sent to IB.
* The chart (`features/chart`) follows the setting too. Its label functions (`chartMath.ts →
  formatBarTime`, `timeTicks`, `timeAxisLabels`) take a `LabelClock` (the format and language of a
  `Clock`; `PriceChart` passes `useClock()`). Intraday axis ticks and the crosshair chip write every
  clock label with its period ("10:30 AM", "上午 10:30", "7:58:15 PM" on seconds intervals), so a
  label read on its own is never ambiguous; noon is "12:00 PM" / "下午 12:00", and midnight starts a
  day, so it shows the date. Dates, months, quarters and years are the same in both formats. The
  12-hour labels are wider, so `timeTickGap(tf, clock, step)` (the widest clock label of the interval
  plus a clearance, at least `TIME_TICK_GAP`) replaces the fixed gap when picking the tick step and
  thinning ticks; zh and seconds labels thin out to coarser steps. Only clock steps get the wider
  gap: calendar steps (days and longer, and every step of 2 to 4-hour bars) label dates only and keep
  `TIME_TICK_GAP`, so a zoomed-out intraday axis shows the same dates in both formats. The header's
  last-trade time (`sessionQuote.ts → etTime`), the symbol activity panel's order times
  (`timeColumn(clock)`) and its status texts (`orderModel.ts → orderStatusText(o, labels, clock)`:
  "After 9:35 AM ET", "GTD 10/09 4:00 PM ET") use the clock as well. The good-after time is read by
  the Orders page's `parseGoodAfter`, so IB's UTC form ("20261005-13:35:00") and other zones
  ("… Asia/Shanghai") show the same time as there, and "Modify" loads the ticket with its 24-hour
  US/Eastern time.

## Conventions

* Code, comments and docs are English. Chinese appears only in `zh` message tables.
* Numbers use `src/shared/format.ts` (`f2`, `f0`, `sg`, `pct`, `px`, …) with U+2212 for negatives.
* Clock times people read go through `src/shared/timeFormat.ts` (see *Time format*); `format.ts`'s
  `hms` / `hmsMs` stay for the API log and CSV exports, and IB gets its own 24-hour strings
  (`orderTiming.ts`).
* Instruments are `ContractRef`; use `contractKey()` for map keys and `contractLabel()` for display.
* No border radius anywhere; borders are `box-shadow: inset 0 0 0 1px var(--ln)`.
* Prefer the `.ellipsis` class (`styles/global.css`) for one-line truncation over inline
  `overflow: hidden`: it clips with a small `overflow-clip-margin`, so descenders (g, p, y) and CJK
  glyphs stay whole with tight line-heights such as `font: 13px/1`. Keep some padding between it
  and the inner edge of a scrolling box (the margin can make that box scroll by about 0.2em), and
  do not test it for truncation with `scrollWidth` (see the comment on the class).
* No npm runtime dependencies: `dependencies` stays empty; renderer libraries are devDependencies
  bundled by Vite.

## Development

```bash
pnpm dev          # Vite dev server + Electron with restart on main/preload changes
pnpm typecheck    # TypeScript 7 (tsc) for node and web projects
pnpm test         # Vitest unit tests (src/**/*.test.ts)
pnpm build        # Production bundles in out/
pnpm dist         # Packaged app via electron-builder (release/)
```

Environment variables for development:

| Variable | Effect |
| --- | --- |
| `TAPE_DEMO=1` | Market data (quotes, bars, depth, option chains) comes from a built-in simulator |
| `TAPE_NO_CONNECT=1` | Do not auto-connect on launch |
| `TAPE_CLIENT_ID=<n>` | Override the API client id |
| `TAPE_USER_DATA=<dir>` | Use a separate profile directory |
| `TAPE_OUT=<dir>` | Build into `<dir>` instead of `out` |
| `TAPE_CAPTURE_DIR`, `TAPE_CAPTURE_STEPS`, `TAPE_CAPTURE_QUIT` | Scripted screenshots, see `src/main/devCapture.ts` |
| `TAPE_FAKE_BIOMETRICS=[touchId:\|windowsHello:]ok\|fail\|cancel\|unavailable` | Fake Touch ID / Windows Hello without a system prompt (ignored when packaged) |
| `TAPE_LIVE_IB=<host:port>` | Runs `src/main/ib/live.test.ts` against a logged-in paper TWS / IB Gateway (with `TAPE_CLIENT_ID`) |
