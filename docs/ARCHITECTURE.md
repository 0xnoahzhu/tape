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
| `store.ts` | JSON persistence in `userData` (settings, watchlists, alerts, notifications, window bounds; `nav.json` only for its one-time import into `tape.db`) |
| `db/` | `ctx.db`: SQLite caches and journals in a worker thread (see *Database*) |
| `ib/tws/` | Dependency-free TWS API client (`IBApi`, see *TWS API client*) |
| `ib/connection.ts` | `IBApi` lifecycle, handshake, auto-reconnect, heartbeat, request/order id allocation, error routing |
| `ib/apiLog.ts` | Records every sent/received frame, on-demand streaming to the API log views, daily log files, retention |
| `ib/account.ts` | Account summary, positions/portfolio, P&L, NAV sampling (`navHistory.ts`, stored in `ctx.db.nav`) |
| `ib/orders.ts` | Open orders of all clients, order status, place/modify/cancel, executions and commissions (journaled in `ctx.db.executions`) |
| `market/contracts.ts` | Symbol search, contract details cache |
| `market/quotes.ts` | Market data subscriptions, tick mapping, batching; demo simulator when `TAPE_DEMO=1` |
| `market/history.ts` | Historical bars per timeframe |
| `market/depth.ts` | Level 2 book |
| `market/options.ts` | Option chain parameters (`reqSecDefOptParams`) |
| `market/alerts.ts` | Price alert evaluation |
| `notifications.ts` | In-app notification list + OS notifications |
| `appearance.ts` | Theme (`nativeTheme.themeSource`) and theme-matched dock/window icon |
| `menu.ts` | Application menu (localized), menu commands |

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
and count as its own.

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

* Schema (`schema.ts`): `series` (`key`, `intraday`, `last_access`, `bar_count`) + `bars`
  (WITHOUT ROWID, clustered by series and time), `kv` (`ns`, `key`, JSON, `updated_at`),
  `executions` (by `exec_id`, indexed by time), `nav` (`t`, `net_liq`). WAL; versioned migrations
  (v2 added `last_access`, set to the migration time, and `bar_count`, counted once).
* Writes never reject (best-effort, logged); writes that arrive together commit in one transaction.
  Reads reject on database errors.
* Series access: every `bars.get` / `bars.put` notes the series in the worker's memory; its
  `last_access` (unix ms) is written at most once an hour per series, in one transaction for all
  pending series when the worker is idle (and on close).
* Retention policy (`db/types.ts`), so the file cannot grow without bound:

  | Data | Kept |
  | --- | --- |
  | Intraday bars | 30 days; a series left empty is removed |
  | Any series (in practice daily and longer) | Evicted with its coverage and head timestamp when not read or written for 90 days |
  | Size cap | Above 512 MB (`tape.db` + WAL), series are evicted until the data is under 80% of the cap: first those not used for 7 days (intraday before daily, least recently used first), then the recently used ones, least recently used first (the chart on screen goes last) |
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

## Conventions

* Code, comments and docs are English. Chinese appears only in `zh` message tables.
* Numbers use `src/shared/format.ts` (`f2`, `f0`, `sg`, `pct`, `px`, …) with U+2212 for negatives.
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
| `TAPE_LIVE_IB=<host:port>` | Runs `src/main/ib/live.test.ts` against a logged-in paper TWS / IB Gateway (with `TAPE_CLIENT_ID`) |
