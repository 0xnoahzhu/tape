# Tape

Tape is a desktop trading client for [Interactive Brokers](https://www.interactivebrokers.com). It connects
to **TWS** or **IB Gateway** through the TWS API socket on your machine, so your login, two-factor
authentication and market data subscriptions stay with IBKR's own software. Tape is built with Electron,
TypeScript and React and runs on macOS, Windows and Linux.

Architecture notes for contributors are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Feature tour

**Portfolio** — net liquidation, day / unrealized P&L, buying power and cash; an equity curve built from
sampled net liquidation values (kept locally); a positions table with
average cost, last price, market value and P&L; a sector allocation chart; a performance view.

**Trade**

- **Watchlists** with groups, built-in US index and macro lists, symbol search (IBKR contract search) and
  per-row actions.
- **Chart** with 1m / 5m / 1h / 1D / 1W / 1M / 1Y bars from IBKR historical data, MA20 and volume, session
  status, and the position and open orders for the selected symbol.
- **Order ticket**: limit, market, stop, stop limit and trailing stop (amount or percent); time in force DAY /
  GTC / IOC / FOK / OPG / GTD (with an expiry in New York time); **trading session** regular hours, extended
  hours (pre-market and after-hours), overnight, or overnight + day (US stocks and ETFs, DAY limit orders);
  choices IBKR does not combine are disabled with the reason; **bracket** orders (take-profit and stop-loss children); **conditional**
  orders (price condition on any instrument); **iceberg** (display size); **good-after** time. Optional
  confirmation before every order; keyboard entry (B / S, ↑ / ↓ for quantity, ⏎ to submit).
- **Symbol search** (⌘K / Ctrl+K): find a ticker or company and open it on the Trade page; orders are
  entered in the order ticket.
- **Options**: chain with quotes, greeks, value and probability columns, expiries by type, ATM IV and
  expected move; strategy builder with payoff and risk; volatility view; unusual options flow; option
  positions with risk alerts.
- **Depth**: 10-level book (Level 2) when enabled and subscribed.

**Orders** — working orders (modify, cancel, cancel all) and today's trades with commissions, CSV export.

**Notifications and price alerts** — fills, order updates, price alerts, option risk alerts and connection
events appear in the bell; each kind can also be pushed to the system notification center, with sound and
do-not-disturb switches. Clicking a notification about an instrument opens it.

**API log** — every message sent to and received from TWS / IB Gateway, decoded field by field, with
daily log files, retention and export.

**Appearance** — dark, light or system theme (the dock / window icon follows the theme), red-up / green-down
(CN) or green-up / red-down (US) color convention, English and 中文.

Where IBKR does not provide a value (no market data permission, a competing session, a closed market) Tape
shows "—" or an explanatory empty state instead of inventing numbers.

## Requirements

- **Node.js 22.18 or newer** (the build scripts are TypeScript files run directly by Node) and
  **pnpm 10** (`corepack enable`).
- **IB Gateway or TWS** (stable or latest) logged in to a live or paper account, with the API enabled.
- Market data subscriptions for the instruments you want quotes for (US equities, OPRA for options,
  TotalView / OpenBook for depth). See *Help › IBKR market data subscriptions* in the app.

## IB Gateway / TWS API settings

In IB Gateway open *Configure › Settings › API › Settings*; in TWS open *Global Configuration › API › Settings*.

| Setting | What Tape needs |
| --- | --- |
| Enable ActiveX and Socket Clients | On (TWS only; IB Gateway always listens). |
| Socket port | IB Gateway: **4002** paper / **4001** live. TWS: **7497** paper / **7496** live. Must match *Settings › Connection* in Tape (default 127.0.0.1:4002). |
| Read-Only API | **Off** to place, modify or cancel orders. While it is on, IBKR rejects every order (error 321, shown with where to turn it off); quotes, account data and positions still work. Tape has no read-only switch of its own: use this one to keep it from trading. |
| Download open orders on connection | On, so working orders show up as soon as Tape connects. |
| Allow connections from localhost only | Recommended. To connect from another machine, turn it off and add that machine under *Trusted IPs*. |

**Overnight-only orders** are routed directly to IBKR's OVERNIGHT venue. With the default API precautions IB
refuses them (error 10329, shown with where to change it): turn on *Bypass Redirect Order warning for Stock API
orders* under *API › Precautions* to send them. Overnight + day orders are SMART-routed and need no change.

**Client ids.** Every program connected to the same TWS / Gateway needs its own client id (Tape uses 7 by
default; change it in *Settings › Connection › Advanced*, or set `TAPE_CLIENT_ID` for a development run). Orders
belong to the client id that placed them; client id 0 also sees orders entered manually in TWS.

**Market data sharing and error 10197.** IBKR delivers real-time market data to one session per username.
A paper account receives data only when *Share real-time market data subscriptions with paper trading
account* is enabled for it (Client Portal › Settings › Account Settings › Paper Trading Account), and only
while the live username is not using market data elsewhere. If the live account is logged in on another
device (TWS, Client Portal, IBKR Mobile), the paper session gets error **10197** "No market data during
competing live session", and historical data requests fail with error **162** ("Trading TWS session is
connected from a different IP address"). Log out of the other session, or use a separate username for API
access. Account data, positions, orders and contract search keep working in the meantime, and Tape shows the
reason next to the affected quotes and charts.

IBKR's own guide: [TWS configuration for API use](https://www.interactivebrokers.com/docs/tws-api/doc/tws-settings/tws-configuration-for-api-use/introduction)
(also under *Help › API settings help*).

## Getting started

```bash
pnpm install
pnpm dev        # Vite dev server + Electron, restarts on main / preload changes
```

Tape connects on launch (Settings › Connection › auto-connect). To try the interface without market data
permissions, run with simulated quotes: `TAPE_DEMO=1 pnpm dev`.

## Scripts

| Script | Description |
| --- | --- |
| `pnpm dev` | Development: renderer dev server, watch builds of main and preload, Electron restarts on change |
| `pnpm build` | Production bundles in `out/` (`TAPE_OUT=<dir>` for another folder) |
| `pnpm start` | Runs the built app from `out/` |
| `pnpm typecheck` | TypeScript checks for the main / preload and renderer projects |
| `pnpm test` | Vitest unit tests (`src/**/*.test.ts`) |
| `pnpm icons` | Renders the app icons from `resources/icons/*.svg` (see below) |
| `pnpm dist` | Build and package installers into `release/` |
| `pnpm dist:dir` | Build and package an unpacked app only (e.g. `release/mac-arm64/Tape.app`) |

## Development environment variables

| Variable | Effect |
| --- | --- |
| `TAPE_DEMO=1` | Market data (quotes, bars, depth, option chains) comes from a built-in simulator |
| `TAPE_NO_CONNECT=1` | Do not auto-connect on launch |
| `TAPE_CLIENT_ID=<n>` | Override the API client id |
| `TAPE_USER_DATA=<dir>` | Use a separate profile directory |
| `TAPE_OUT=<dir>` | Build into `<dir>` instead of `out` |
| `TAPE_CAPTURE_DIR`, `TAPE_CAPTURE_STEPS`, `TAPE_CAPTURE_QUIT` | Scripted screenshots, see `src/main/devCapture.ts` |
| `TAPE_LIVE_IB=<host:port>` | Enables `src/main/ib/live.test.ts`, which connects to a logged-in **paper** TWS / IB Gateway (set `TAPE_CLIENT_ID` to an unused id); it places a BUY 1 AAPL limit order at 1.00 and cancels it |

`scripts/capture.ts` wraps the capture variables for a built app:
`node scripts/capture.ts --out out --dir /tmp/shots --steps steps.json [--demo] [--connect --client-id <n>]`.

## Data on disk

Everything is stored locally in the user data folder (macOS `~/Library/Application Support/Tape`,
Windows `%APPDATA%\Tape`, Linux `~/.config/Tape`):

| File | Contents |
| --- | --- |
| `settings.json` | Settings (validated on load; unknown keys are dropped) |
| `watchlists.json` | Watchlists and groups |
| `alerts.json` | Price alerts |
| `notifications.json` | The last 200 notifications |
| `window.json` | Window position and size |
| `tape.db` | SQLite database (with `-wal` / `-shm` files): net liquidation history for the equity curve and a journal of executions with commissions; its cache tables expire (intraday bars after 30 days, other entries after 180 days) |
| `nav.json` | Older versions' equity curve data; imported into `tape.db` once, then emptied |

JSON files are written atomically. A file that cannot be read is kept as `<name>.corrupt-<timestamp>.json`
and the defaults are used instead; an unreadable `tape.db` is moved aside as `tape.db.corrupt-<timestamp>`
and recreated. API log files (`api-YYYYMMDD.log`) go to the system log folder (macOS
`~/Library/Logs/Tape`) and are deleted after the retention period chosen in *Settings › API log*.

## Packaging

```bash
pnpm icons      # only after changing resources/icons/*.svg
pnpm dist       # macOS: dmg + zip, Windows: NSIS installer, Linux: AppImage
```

Configuration is in [`electron-builder.yml`](electron-builder.yml); output goes to `release/`.

- **Icons.** `resources/icons/icon-dark.svg` and `icon-light.svg` are the source artwork. `pnpm icons`
  renders the macOS dock icons (`icon-<theme>.png`, 1024 px on Apple's icon grid with a drop shadow), the
  full-bleed window icons (`icon-<theme>-256.png` / `-512.png`) and the bundle icons in `build/`
  (`icon.png`, `icon.icns` via `iconutil` on macOS, `icon.ico`). The PNGs ship in the app's `resources/icons`;
  at runtime Tape switches the dock icon (macOS) or window icon (Windows, Linux) when the theme changes. The
  bundle icon shown by Finder and installers is the dark one.
- **Signing.** electron-builder signs with a code signing identity from your keychain when it finds one and
  skips signing otherwise. Hardened runtime and notarization are off for local builds; to distribute, use a
  Developer ID certificate (`CSC_NAME` / `CSC_LINK`), enable `hardenedRuntime` and configure notarization.
  macOS only delivers system notifications from signed apps.

## Project structure

```
src/
  shared/      types, IPC contract (TapeApi / TapeEvent), formatting and contract helpers, defaults
  main/        Electron main process
    index.ts         services, window, IPC handlers
    store.ts         JSON persistence (storeSchema.ts validates, jsonFile.ts writes atomically)
    db/              tape.db: SQLite (node:sqlite) in a worker thread, in-memory fallback
    ib/              connection, account, orders, API log
      tws/           dependency-free TWS API client: socket, encoder / decoder, send queue, pacing
    market/          contracts, quotes, history, depth, options, price alerts, demo simulator
    notifications.ts in-app list + OS notifications
    appearance.ts    theme and theme-matched icons
    menu.ts          localized application menu (menuTemplate.ts)
  preload/     contextBridge: exposes window.tape
  renderer/    React UI
    src/state/       zustand store, IPC bridge
    src/features/    portfolio, watchlist, chart, ticket, options, orders, notifications, alerts, search, settings
    src/ui/          design primitives; src/styles: tokens and global CSS
resources/icons/   icon sources and generated runtime icons
build/             bundle icons for electron-builder
scripts/           dev, build, capture and icon scripts
design/            design files (source of truth for the UI)
```

## Security

- The renderer is sandboxed (`sandbox`, `contextIsolation`, no Node integration). It can only call the typed
  `window.tape` API defined in `src/shared/ipc.ts`; the main process validates what it persists.
- Tape never asks for or stores IBKR credentials. Authentication happens in TWS / IB Gateway; Tape only opens
  a socket to the API port (127.0.0.1 by default).
- The app does not navigate away from its own page; external links open in your default browser (https only).
- Local files (see *Data on disk*) are plain JSON and log text. API log files contain account ids and order
  details; turn off *Also write to log file* in *Settings › API log* if you do not want them on disk.

## License

[Apache License 2.0](LICENSE)
