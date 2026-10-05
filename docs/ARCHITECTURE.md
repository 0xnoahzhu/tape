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
| `market/alerts.ts` | Price alert evaluation |
| `notifications.ts` | In-app notification list + OS notifications |
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

### TWS API client (`src/main/ib/tws`)

An in-repo replacement for the parts of `@stoqey/ib` Tape uses (same `IBApi` method names, event
names and listener arguments), built on `node:net` and `node:events` only.

* `connection.ts` — the socket, the `API\0` handshake offering server versions 176..193
  (`messageIds.ts`; TWS / IB Gateway 10.x) and length-prefixed frames of NUL-separated fields.
* `encoder.ts` / `decoder.ts` — requests and messages; `client.ts` is `IBApi`. Requests made before
  `nextValidId` are held and flushed after it. Every frame sent and received is also emitted as
  `sent` / `received` (the API log records them).
* `sendQueue.ts` — every frame goes through one queue: at most 45 messages per second (IB allows
  50), a burst of 10 and then spread evenly, halved for 10 s after IB's error 100. Lanes: orders,
  then control / account, then market data (FIFO per lane; market data that waited 1 s goes ahead
  of younger control frames). A cancel whose request is still unsent removes both.
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
  | `kv` (contract details, option chains, coverage, head timestamps) | Entries not rewritten for 180 days are deleted |
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
(`basic`, `underlying`, `option`), and cancels lines nobody wants. At most 95 lines are open (IB's
default limit is 100), in the order the contracts were first wanted; the rest carry a "line limit"
error on their quote. Price alerts are an owner too. After every handshake and after 1101, market
data type 4 (delayed-frozen fallback) is set and all lines are requested again.
Errors after which IB dropped a line end it; 10197 (competing live session) keeps it open and is
shown on the quote and the connection. Quote changes reach the renderer as `quotes` events batched
every 100 ms. The Level 2 book (`market/depth.ts`) uses one depth line at a time (IB allows 3).

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
  executions refresh), the cache size poll, API log streaming, `notify` (the option risk watcher) and the lock methods. The order
  service checks the lock again before sending (also after its contract lookup). The menu disables its
  custom items except *Lock Tape*; notification clicks only show the window; on Windows / Linux the
  caption buttons take the lock screen's background (`Appearance.setLocked`; restored ~1.1 s after the
  unlock, when the renderer's animation has played). Handlers that wait for the user (the API log's save
  dialog) check the lock again afterwards. Scripted captures (`devCapture.ts`) never run in a packaged app. IB stays connected; alerts
  keep running in main.
* Renderer: `features/lock/LockScreen.tsx` sits above everything (z-index 40) while the app under it is
  `inert`; `state/lockActions.ts` closes dialogs, the bell, popovers and drops a pending order review when
  locking; a capture key listener (`features/lock/actions.ts → installLockKeyGuard`) keeps every shortcut
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
