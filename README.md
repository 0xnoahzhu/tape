# Tape

Tape is a desktop trading client for [Interactive Brokers](https://www.interactivebrokers.com). It connects
to **TWS** or **IB Gateway** through the TWS API socket on your machine, so your login, two-factor
authentication and market data subscriptions stay with IBKR's own software. Tape is built with Electron,
TypeScript and React and runs on macOS, Windows and Linux.

Architecture notes for contributors are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Feature tour

**Portfolio** — net liquidation, day / unrealized P&L, buying power and cash; an equity curve built from
sampled net liquidation values (kept locally); a positions table with
average cost, last price, market value and P&L; a sector allocation chart; a performance view. The
Dashboard's widgets add margin cushion, portfolio Greeks, concentration, today's P&L by position, option
expirations, today's trades, a benchmark comparison and **earnings & dividends** for the holdings.
Ex-dividend dates and amounts come with IB's quotes. Earnings dates come from Wall Street Horizon when
the account has that IBKR subscription; otherwise Tape estimates them from IB's market scanner (US stocks:
the date and before the open / after the close, marked *Est.*, since IB marks none as confirmed).

**Trade**

- **Watchlists** with groups, built-in US index and macro lists, symbol search (IBKR contract search) and
  per-row actions. A star in the chart header opens a list → group picker for the charted symbol: check
  a group to add it there (or move it there within that list), uncheck it to take it out of that list.
  The star is filled while any list holds it.
- **Chart** from IBKR historical data in every interval IBKR offers: seconds (1s 5s 10s 15s 30s, and 45s
  merged from 15-second bars), minutes (1m 3m 5m 10m 15m 30m), hours (1h 2h 3h 4h) and D / W / M / Q / Y,
  plus **ranges** (1M, 3M, YTD, 1Y, 5Y, Max) that pick an interval and fit the chart to the span. A picker
  lists them all; starred ones become toolbar chips. Moving averages (MA5 … MA200) and volume, scrolling back
  through older bars (seconds bars up to six months), live bars from real-time quotes (a note says when
  delayed data keeps seconds bars from being live), session status, the watchlist star and price-alert bell
  in the header, and the position and open orders for the selected symbol.
- **Order ticket**: limit, market, stop, stop limit and trailing stop (amount or percent), and under **More**
  market / limit if touched, trailing stop limit, trailing MIT / LIT, market / limit on close, market / limit
  on open, market to limit, midprice, relative, snap to midpoint / market and pegged to midpoint; time in force
  DAY / GTC / IOC / FOK / OPG / GTD (with an expiry in New York time); **trading session** regular hours,
  extended hours (pre-market and after-hours), overnight, or overnight + day (US stocks and ETFs, DAY limit
  orders). **Advanced**: **bracket** orders (take-profit, and a stop-loss as stop, stop limit, trailing stop
  or trailing stop limit) and **adjustable stops**; **conditions** (price, time, % change, volume, margin
  cushion, execution; and / or; submit or cancel when met); **all or none**, minimum quantity, hidden, sweep
  to fill, discretionary amount, **iceberg**, forex orders sized by amount; **trigger method**; **IB algos**
  (Adaptive, VWAP, TWAP, Arrival price, Close price, % of volume and its variants, Dark ice, Accumulate /
  distribute, and for options Minimise impact and Balance impact and risk) with their parameters; **OCA
  groups**; directed routing; **good-after** time; a note. Choices IBKR does not combine are disabled with
  the reason. Optional confirmation before every order, with IBKR's **margin and commission estimate**
  (what-if); keyboard entry (B / S, ↑ / ↓ for quantity, ⏎ to submit).
- **Floating order ticket and strategy builder**: the pop-out icon at the top right of the order ticket
  or the strategy builder turns it into a panel floating over the page inside Tape's window; the chart,
  depth or option chain then uses the full width. Drag it by its header, resize it from any edge or
  corner. It is laid out for its size: from about 900 px wide in three columns (market: bid / ask, 5
  depth levels, the position and working orders; entry: side, type, quantity and price with quick chips
  100 / 500 / 1K / Position and Bid / Mid / Ask, ± one tick; confirm: the advanced sections, the totals
  with IBKR's what-if, the submit button), narrower as the docked panel. After a submit a status strip
  follows the order (submitted, partial fills with progress, filled with average price, position change
  and commission, or IBKR's rejection). The chevron (or Esc) collapses it to a slim bar with the latest
  order's status and Buy / Sell; an accepted order does this by itself. The dock-back icon puts it back
  in the right column. Tape remembers per device which panels float, where, and whether collapsed.
- **Symbol search** (⌘K / Ctrl+K): find a ticker or company and open it on the Trade page; orders are
  entered in the order ticket.
- **Options**: chain with quotes, greeks, value and probability columns, expiries by type, ATM IV and
  expected move; strategy builder with payoff and risk, sent at the net mark or at market, DAY or GTC, combos optionally
  non-guaranteed; volatility view; unusual options flow; option
  positions with risk alerts. Always available: without OPRA the quotes are delayed, and the flow is
  computed from the chain quotes on screen.
- **Depth**: 10-level book (Level 2) on the Trade page and 5 levels a side in the floating order ticket, behind the
  switch in *Settings › Market Data* (off by default: an open book uses one of the depth lines IB allows per
  user, 3 by default, shared with TWS and other API clients). Tape tests Level 2 when the section opens
  without a Level 2 answer for the connected account (Tape keeps the last check only, so again after you switch
  accounts) and on *Check now*; a full book from IB (no 2152 within a minute) turns it on unless you have set
  the switch yourself, and a book from some exchanges only (IB's 2152, e.g. IEX only) leaves it off, with a
  note under the switch.

**Orders** — working orders with their attributes (modify, cancel, cancel all) and today's trades with commissions, CSV export.

**Notifications and price alerts** — fills, order updates, price alerts, option risk alerts and connection
events appear in the bell; each kind can also be pushed to the system notification center, with sound and
do-not-disturb switches. On macOS and Windows, orders, fills and everything else each play their own
system sound (chosen in Settings › Notifications, with a sample button; None mutes a category). On macOS
Tape plays the sound itself, so a Focus mode does not mute it; use Tape's do-not-disturb. On Linux the
notification server decides the sound. Clicking a notification about an instrument opens it.

**API log** — every message sent to and received from TWS / IB Gateway, decoded field by field, with
daily log files, retention and export.

**General** — dark, light or system theme (the dock / window icon follows the theme, and on macOS so does
Tape's icon in Finder), red-up / green-down (CN) or green-up / red-down (US) color convention, English and
中文, and 12-hour ("9:41 AM", "上午 9:41"; the default) or 24-hour ("09:41") clock times everywhere you read
them; the API log, CSV exports and what is sent to IB stay 24-hour.

**Lock screen** — lock Tape with ⌘L / Ctrl+L or the padlock in the top bar; it also locks after a chosen
idle time. Unlock with a 6-character PIN, Touch ID or Windows Hello (see *Lock screen* below).

Where IBKR does not provide a value (no market data permission, a competing session, a closed market) Tape
shows "—" or an explanatory empty state instead of inventing numbers.

**Market data check** — Tape always asks IB for the best data it offers (live where you are subscribed,
15–20 min delayed elsewhere), so there is nothing to set. *Settings › Market Data* shows what this account
actually gets: for a few seconds Tape holds streaming quotes for SPY (through SMART and on its own exchange),
a near-the-money SPY option and SPX, and a Level 2 book on *Check now* and when the section opens without a
Level 2 answer for the connected account (only the last check is kept, so also after switching accounts),
then releases them. Each market shows its status with a short note (Live, Live on one
exchange only, Delayed, Not subscribed, Market closed): delayed or unsubscribed markets are normal and stay
muted, and only a competing live session is flagged, with what to do about it; a paper account on which
nothing is live gets a hint about sharing the live account's market data. The details are on demand: IB's
codes and messages in the tooltips, and the request type, every answer and the quote field sources under
*Technical details*. The check runs quietly after connecting, and again from the section when its result is
older than five minutes or a competing session has ended since; the last result is kept across restarts. Lines
already open for the watchlist, chart or option chain are reused, and regulatory snapshots (which IBKR
charges for) are never used.

**Exchange quotes when SMART is delayed** — IBKR can send an account a stock's consolidated (SMART) quote
delayed while the stock's own exchange sends live data (seen on a paper account: AAPL delayed on SMART, live
on NASDAQ). Tape then quotes that stock from its primary exchange, marked "Live · NASDAQ" on the chart, in
the watchlist and in the order ticket: the bid, ask and last on that exchange, not the national best bid
and offer. It tries SMART again every 10 minutes, after a reconnect and when a competing session ends, and
goes back to the consolidated quote as soon as SMART is live (or when the exchange turns delayed too).
Settings › Market Data lists the stocks quoted this way during the session under *Technical details*, also
after you have left their page.

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
| `TAPE_FAKE_BIOMETRICS=[touchId:\|windowsHello:]ok\|fail\|cancel\|unavailable` | Development builds only: a fake Touch ID / Windows Hello that never shows a system prompt (ignored when packaged) |
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
| `lock.json` | The lock PIN as a salted scrypt hash and the count of wrong PINs (mode 0600; never the PIN itself) |
| `tape.db` | SQLite database (with `-wal` / `-shm` files): net liquidation history for the equity curve and a journal of executions with commissions; its cache tables expire (seconds bars after 6 days, minute bars after 30, 30-minute and hour bars after 400, other entries after 180 days) |
| `nav.json` | Older versions' equity curve data; imported into `tape.db` once, then emptied |

JSON files are written atomically. A file that cannot be read is kept as `<name>.corrupt-<timestamp>.json`
and the defaults are used instead; an unreadable `tape.db` is moved aside as `tape.db.corrupt-<timestamp>`
and recreated. API log files (`api-YYYYMMDD.log`) go to the system log folder (macOS
`~/Library/Logs/Tape`) and are deleted after the retention period chosen in *Settings › API log*.

## Packaging

```bash
pnpm icons      # only after changing resources/icons/*.svg
pnpm dist       # macOS .dmg + Windows x64 NSIS setup .exe (pnpm dist:mac / dist:win for one platform)
```

Configuration is in [`electron-builder.yml`](electron-builder.yml); output goes to `release/`, and
`scripts/clean-release.ts` leaves only the `.dmg` and the `-setup.exe` there. A Linux AppImage can be built
with `electron-builder --linux` after `pnpm build`.

- **Icons.** `resources/icons/icon-dark.svg` and `icon-light.svg` are the source artwork. `pnpm icons`
  renders the macOS dock icons (`icon-<theme>.png`, 1024 px on Apple's icon grid with a drop shadow), the
  dark Finder icon (`icon-dark.icns`, via `iconutil` on macOS), the full-bleed window icons
  (`icon-<theme>-256.png` / `-512.png`) and the bundle icons in `build/` (`icon.png`, `icon.icns` via
  `iconutil` on macOS, `icon.ico`). The PNGs and `icon-dark.icns` ship in the app's `resources/icons`; at
  runtime Tape switches the dock icon (macOS) or window icon (Windows, Linux) when the theme changes. The
  bundle icon shown by installers (and by Finder, unless the dark Finder icon below is set) is the light one.
- **Finder icon (macOS).** While Tape runs from `/Applications` or `~/Applications`, its icon in Finder (and
  its Dock tile while it is not running) follows the theme, like Arc's. For dark, Tape gives its bundle a
  Finder custom icon (`NSWorkspace setIcon:forFile:options:` via `osascript`): an empty `Tape.app/Icon\r`
  file whose resource fork holds `icon-dark.icns`, and the custom-icon flag in the bundle's
  `com.apple.FinderInfo`. Light removes both, so the light bundle icon shows again. Nothing in `Contents/`
  changes: `codesign --verify --deep` passes and Tape launches as before, but while the dark icon is set
  `codesign --verify --deep --strict` reports "resource fork, Finder information, or similar detritus not
  allowed" (Arc's bundle reports the same). Switch to Light first, or run
  `rm "/Applications/Tape.app/Icon"$'\r'; xattr -d com.apple.FinderInfo /Applications/Tape.app`, before a
  strict check. The icon only changes while Tape runs: if macOS switches appearance while Tape is closed,
  the last icon stays until the next launch, and an update (a new bundle) starts light. Tape treats any
  custom icon on its bundle as its own: while dark it sets its dark icon once per launch and at each
  switch to dark, which replaces one set with Get Info and repairs one stripped by `xattr -cr`, and Light
  removes it. It leaves the
  bundle alone when it runs translocated, from the DMG or outside the Applications folders, or cannot
  write it; a failure is logged once and changes nothing else.
- **Electron fuses.** The packaged binary has `runAsNode`, `NODE_OPTIONS` and `--inspect` turned off and only
  loads the `app.asar` it was built with (embedded asar integrity), so it cannot be used as a plain Node
  runtime or started with modified app code. Check with `npx @electron/fuses read --app release/mac-arm64/Tape.app`.
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
    finderIcon.ts    macOS: the bundle's Finder icon follows the theme
    menu.ts          localized application menu (menuTemplate.ts)
    lock/            lock screen: PIN hash and backoff, idle auto-lock, Touch ID / Windows Hello, Forgot-PIN reset
    ipcDispatch.ts   IPC envelope and the methods refused while locked
  preload/     contextBridge: exposes window.tape
  renderer/    React UI
    src/state/       zustand store, IPC bridge
    src/features/    portfolio, watchlist, chart, ticket, options, orders, notifications, alerts, search, settings, lock
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

## Lock screen

The lock screen is a privacy lock for Tape's window: it hides balances, positions and orders and refuses
everything a user would do (orders, settings, watchlists, alerts, logs) until the PIN is entered.

- **Lock** with ⌘L / Ctrl+L, the padlock in the top bar or *Tape › Lock Tape*. The first time, Tape asks for
  a PIN and locks once it is saved. *Settings › Privacy & Security* sets the idle time (15 / 30 / 60 minutes,
  custom or never; no keyboard or mouse input on the computer, checked every 15 s), the unlock method, the
  unlock sound, and changes or removes the PIN. Tape starts locked whenever a PIN is set.
- **PIN**: exactly 6 characters of any kind (letters are case-sensitive; digits, symbols and other scripts
  work; spaces and control characters do not). It is only stored as a salted scrypt hash in `lock.json`.
  After 5 wrong PINs in a row Tape waits 30 s before the next attempt, doubling up to 15 minutes; the count
  survives a restart. If `lock.json` cannot be read (damaged, or blocked by permissions), Tape stays locked
  and accepts no PIN; *Forgot PIN?* is the way out.
- **What keeps running**: IB Gateway / TWS stays connected, market data keeps flowing, orders already sent
  keep working on IB's servers and price alerts keep firing.
- **What it does not protect**: IB Gateway / TWS stays logged in and accepts any local API client, so anyone
  at the computer can still use IBKR through another program, and the files in the user data folder are
  readable by your user account. *Forgot PIN?* needs no PIN either: anyone at the computer can reset Tape
  (losing its local data) and connect it to the running IB Gateway again. Use the lock as a privacy screen;
  to prevent trading, lock the computer itself or log out of IB Gateway.
- **Forgot PIN?** The PIN cannot be recovered. *Reset Tape* on the lock screen (type RESET / 重置) deletes all of
  Tape's local data: settings, watchlists, price alerts, notifications, API logs, the PIN, the database
  (equity curve history, executions journal, caches) and the window position; only the language and the
  theme are kept. Tape then restarts like a fresh install, on *Settings › Connection*, without connecting.
  Your IBKR account, positions and orders on IB's servers are not affected.
- **Touch ID** (macOS) needs a Mac or Magic Keyboard with Touch ID and an enrolled fingerprint; it is not
  available while the lid is closed without a Touch ID keyboard. The system sheet may also offer your Mac
  password. **Windows Hello** needs Windows 11, or Windows 10 where the API is present, with Windows Hello
  set up (see below). Neither is offered on Linux. The PIN always works as well.

### Windows Hello

Electron has no Windows Hello API, so Tape asks Windows itself (`src/main/lock/windowsHello.ts`):

- It calls `UserConsentVerifier` through `IUserConsentVerifierInterop.RequestVerificationForWindowAsync`
  with Tape's window handle, so the *Windows Security* dialog belongs to Tape and opens in front of it. Face,
  fingerprint or the Windows Hello PIN all count; which one is offered is up to Windows.
- The call runs in a helper process: the in-box Windows PowerShell 5.1
  (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, never looked up through `PATH`) compiles a
  small C# class in memory with the in-box .NET Framework compiler and talks to Tape over stdin / stdout. The
  script is bundled in the app (`windowsHelloScript.ts`); nothing is downloaded or installed, no
  `-EncodedCommand` or `-ExecutionPolicy` switches are used, and no cmdlets or modules are loaded.
- The helper starts when Tape locks (so the prompt opens quickly) and ends on unlock and on quit; if Tape
  dies, the helper sees its stdin close and exits. A helper started only to check availability (Settings)
  exits after a minute. A prompt nobody answers is closed after two minutes.
- Requires Windows 11 (build 22000), or Windows 10 where the interop API is present (Microsoft documents it
  from build 22000), with Windows Hello set up. The availability check activates that API, so a build without
  it shows Windows Hello as unsupported instead of offering a button that fails. When PowerShell is missing,
  blocked (including AppLocker / Software Restriction Policy executable rules or Defender), or runs in
  Constrained Language Mode (AppLocker / WDAC script rules), or antivirus blocks the script, Settings shows
  Windows Hello as unavailable for the session and the PIN keeps working.
- As with Touch ID, the OS answers yes or no; it does not unlock a key. The PIN remains the secret, and
  Windows Hello is a shortcut for entering it. The prompt text is never logged.

## License

[Apache License 2.0](LICENSE)
