# Tape

Tape is a desktop trading client for [Interactive Brokers](https://www.interactivebrokers.com). It connects
to **TWS** or **IB Gateway** through the TWS API socket on your machine, so your login, two-factor
authentication and market data subscriptions stay with IBKR's own software. Tape is built with Electron,
TypeScript and React and runs on macOS, Windows and Linux.

Architecture notes for contributors are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Feature tour

**Portfolio** (⌘1 / Ctrl+1) — a two-tier account header with IB's own figures, as IB sends them: net
liquidation, day / unrealized / realized P&L, buying power and excess liquidity with IB's margin
cushion (red below 10%); under it cash (or margin loan), stock and option value, initial and
maintenance margin, IB's leverage and accrued dividends. While Tape is not connected the last figures
stay, dimmed, with when IBKR last sent them (*Disconnected · as of …*). Tabs Positions, Orders and
Trades (⌘3 / Ctrl+3 opens Orders).

- **Positions**: a table of IB's own figures, nothing calculated by Tape (by default Symbol, Qty, Avg
  cost, Price, Value, Unrl. P&L and Day P&L). Where IB sends a figure twice, one column shows it, the
  real-time source first: Price is IB's mark price (tick 37, which Tape asks for on the quote line of
  every stock, future, forex, crypto and option position), Value, Unrl. P&L and Realized P&L come from
  IB's P&L engine (`reqPnLSingle`, about once a second), and each falls back to IB's portfolio update
  (every 3 minutes) until the real-time one comes, as Price does for bonds, CFDs and warrants, which
  get no mark; the cell's tooltip says which it shows. Avg cost is IB's average cost as sent (per
  contract, with commissions). The table is grouped by **underlying** (a stock with its options; the
  default), **sector** or not at all: a group row shows the group's name, its count and its chip, never
  a sum; groups collapse, and a single position stands on its own without a group row. The next
  **earnings or ex-dividend date** within two weeks shows as a chip on the group (or the stock's row):
  *Earnings 10/23 AMC* (Wall Street Horizon, else IB's market scanner), *Ex-div 10/15 $0.24* (IB's dividend data). Option rows
  read *Call · 10/16* (the right and the expiry). A click on a row opens its own chart on the Trade
  page (an option's too); right-click an option for its underlying's option chain. Every column sorts
  the groups (by their best row) and the rows within them. A **column editor** adds contract details, quote fields, IB's option model
  values (IV and greeks), 52-week ranges, volatility, option and trading activity, short-sale data,
  dividends, earnings dates, ETF NAV, futures open interest and bond details (126 columns; those not
  yet checked against IB's data say so, and the extra quote fields are asked of IB only while their
  column is shown, on the positions' own quote lines). All are IB's data except the **Calculated by
  Tape** group, the figures IBKR's own apps show but the API does not send: change and change since
  open (and their %), mid, spread, cost basis, unrealized P&L %, % of net liq, dividend yield, put/call
  volume and open interest, IV/HV and days to the last trading day; each header's tooltip gives the
  formula. Drag a header to move its
  column or its right edge to size it (the columns left of it keep their widths; double-click the edge
  for the default width); a wide table scrolls sideways with its scrollbar always shown, and Tape
  remembers the columns, their order and widths, the sort and the grouping per device (a column choice
  stored by an older version keeps IB's columns under their new names; Price, Value, Unrl. P&L and Day
  P&L stay and now show IB's figures, the per-unit Avg becomes IB's Avg cost, and the other columns
  Tape calculated are dropped). Ex-dividend dates and amounts come with IB's quotes. Earnings dates
  come from Wall Street Horizon when the account has that IBKR subscription; without it Tape finds
  each US stock's date (and time of day) in IB's market scanner, which lists stocks by their next
  earnings date: a few seconds per stock in the background, once a day; the tooltip names the source.
- **Orders**: working orders with their attributes and each instrument's last price beside the order price
  (how far the limit or trigger is from it on hover); modify and cancel the orders Tape placed. The cancel
  dialog names the order, the account (paper or live) and what has filled, and for a bracket what cancelling
  takes with it (or leaves unprotected); the row reads "Cancelling…" until IBKR confirms, and Tape says so
  when IBKR has not confirmed it within 10 s. Orders placed in IBKR Mobile, TWS or the web (or by another API
  app) show where they came from with a **Why?**: IBKR lets only the app that placed an order cancel it.
  **Cancel all…** (IBKR's global cancel, the only way to reach those from Tape) lists every open order and
  account, warns that it cancels every open order of every account of the IBKR login, and needs a tick
  plus a separate confirm. Right before the cancel Tape asks IBKR for its current open orders and sends
  nothing when they are not the ones confirmed (say, a stop-loss placed in IBKR Mobile since); afterwards
  it says how many IBKR cancelled, how many filled first, and how many IBKR no longer lists without saying
  how (never counted as cancelled). IBKR sends Tape no updates of orders placed in other apps, so Tape asks
  for every app's open and completed orders every 30 s and whenever Orders or Cancel all opens; an order
  that ended elsewhere is announced (cancelled, or filled), and one IBKR no longer lists reads "Not reported
  by IB" (not offered for cancel or modify) until IBKR says how it ended. A click on an order (not on
  its Modify / Cancel) opens its instrument's chart, an option's own.
- **Trades**: today's executions with commissions; a click on one opens its instrument's chart.

**Trade**

- **Watchlists** with groups, built-in US index and macro lists, symbol search (IBKR contract search) and
  per-row actions. Drag a row to reorder it or to move it into another group (onto a collapsed group's
  header to add it at its end), and drag a group's header to reorder the groups; Esc undoes a drag. A star in the chart header opens a list → group picker for the charted symbol: check
  a group to add it there (or move it there within that list), uncheck it to take it out of that list.
  The star is filled while any list holds it.
- **Chart** from IBKR historical data in every interval IBKR offers: seconds (1s 5s 10s 15s 30s, and 45s
  merged from 15-second bars), minutes (1m 3m 5m 10m 15m 30m), hours (1h 2h 3h 4h) and D / W / M / Q / Y,
  plus **ranges** (1M, 3M, YTD, 1Y, 5Y, Max) that pick an interval and fit the chart to the span. US
  stocks' minute and hour charts include IBKR's overnight session (20:00–03:50 ET, from the OVERNIGHT
  venue) between the extended-hours days, refreshed every minute while the night runs. A picker
  lists them all; starred ones become toolbar chips. Moving averages (MA5 … MA200) and volume, scrolling back
  through older bars (seconds bars up to six months; nothing before the first one), dragging on past the newest
  bar into empty future time (its dates and hours on the time axis), zooming the price axis by dragging or
  scrolling on it and moving it with a chart drag that starts up or down; every candle in view stays whole on
  the chart, so the prices zoom in no further than they fit and move only within room a zoom out left
  (**Auto**, or a double-click on the axis, fits it to the bars again), zooming the time axis the same way
  (scroll on it, or drag along it: right shows fewer, wider bars; a double-click gives back the automatic
  zoom), a **measure**: hold Shift and drag (or turn on the ruler beside the bell and drag) from one point
  to another: a line and a box on the chart, each end's price beside it (marked as the highest and
  lowest prices are), and in a bubble under the ruler the percent change (large,
  in the up or down color), the price change and the bars between (its ends snap to a bar's open, high,
  low or close within 8 px, the nearest of them, and show as a ring when they do; hold ⌥ to place them
  freely), shown until a click on the chart or Esc; beside the ruler, a **price arrow** (drag up or down
  anywhere: a vertical arrow over a band across the chart, the change from one price to another) and a
  **time arrow** (drag left or right anywhere: a horizontal arrow over a band down the chart, the change
  from the close of the bar it starts at to the close of the bar it ends at, and the bars between), each
  read in the same bubble under its button, live bars from real-time quotes (a note says when
  delayed data keeps seconds bars from being live), session status, the watchlist star and the alert bell
  in the header. Under the chart a panel lists the selected symbol's positions (contract, quantity and
  IB's average cost, value, unrealized and day P&L, as on Portfolio › Positions) and open orders (time,
  side, contract, quantity @ price, last price where the panel is wide enough, status, Modify / Cancel),
  under column names; right-click an option position for its own chart. A splitter resizes the panel
  and it collapses to a bar. An option's chart opens on the Trade page like any instrument's, so the
  order ticket then trades the option.
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
  the reason. The totals show IBKR's **what-if** (initial margin change and commission) as you edit, and
  every order, modify and strategy goes through the **order review** (see *Order review* below; it cannot
  be turned off); keyboard entry once the ticket has the focus (click in it; B / S, ↑ / ↓ for quantity,
  neither while modifying an order; ⏎ to submit, ⏎ again to confirm once the review's Confirm has armed).
  A review closed with Esc or Cancel, or a menu of the ticket, gives the keys back to the ticket; after
  Confirm the ticket waits for a click, so ⏎ pressed again and again never sends the same order twice.
  Keys typed anywhere else — after a symbol search, a click on the chart or the watchlist — never reach the
  ticket, so typing a symbol cannot flip the side or send anything. While an order waits for IBKR's answer
  the button reads *Submitting…* and nothing more is sent. Another instrument starts at its default size
  (*Settings › Trade*'s for stocks and ETFs, 1 contract for options, futures and warrants) and Buy, so a
  stock's 100 never becomes 100 option contracts; selecting the same one again keeps what you set, and a new
  default size or session in Settings › Trade never overwrites one you changed on the ticket. After a
  modify, or *Cancel modify*, the ticket starts fresh: nothing of the working order (its side, size, OCA
  group, conditions, algo, note) carries into the next new order. A red **Delayed 15 min** or **Frozen** tag
  under the bid / ask says when IBKR's prices for the instrument are not live, and on a live account a red
  line above the submit button says orders use real money. With Level 2 on, a 5-level book sits between the
  bid / ask and the entry fields; a click loads a limit order at that level, buying at an ask and selling at
  a bid (while you modify an order, only its price moves).
- **Floating order ticket and strategy builder**: the pop-out icon at the top right of the order ticket
  or the strategy builder turns it into a panel floating over the page inside Tape's window; the chart or
  option chain then uses the full width. Drag it by its header, resize it from any edge or corner. It is
  laid out for its size: from about 900 px wide in three columns (market: bid / ask and, with Level 2 on,
  the 5-level book; entry: side, type, quantity and price with quick chips 100 / 500 / 1K / Position (closes
  the position: its size and the closing side, so a long 100 reads *Sell 100*) and Bid / Mid / Ask, ± one
  tick; confirm: the advanced sections, the totals with IBKR's what-if, the submit button), narrower as the
  docked panel. After a submit a status strip follows the order (submitted,
  partial fills with progress, filled with average price, position change and commission, or IBKR's
  rejection), and the new order flashes in the open orders under the chart. The chevron (or Esc)
  collapses it to a slim bar with the latest order's status and Buy / Sell; an accepted order does this by
  itself. The dock-back icon puts it back in the right column. Tape remembers per device which panels
  float, where, and whether collapsed.
- **Symbol search** (⌘K / Ctrl+K): find a ticker or company and open it on the Trade page; orders are
  entered in the order ticket.
- **Options**: chain with quotes, greeks, value and probability columns, expiries by type; ATM IV, IV
  rank and percentile, expected move and put / call volume (call and put volume on hover) and
  open-interest ratios in the desk header; strategy builder with payoff and risk, sent at the net mark or at market, DAY or GTC, combos optionally
  non-guaranteed; tabs Chain / Volatility: HV 30 from the daily closes (10 and 60 days too), IV30 / HV30
  rich or cheap against the stock's own year, the 25Δ skew (put − call IV, butterfly) and the implied
  against the realized daily move; the OTM smile by strike with the spot price and the 25Δ points; the
  ATM term structure by days to expiry (the selected expiry, three near weeks, the monthly cycles) with
  the ex-dividend and earnings dates; the expected move by expiry (±1σ, range, straddle, forward vol,
  ATM IV at 30/60/90 days, contango or backwardation, and the event move the term structure prices:
  before the next earnings with Wall Street Horizon, else when it shows one in the near weeks); and 52
  weeks of IV against HV with IV's change today and IV rank / percentile over 13, 26 and 52 weeks.
  Charts have an IV % axis; the smile and the history read out the values under the pointer.
  Under the desk the same positions and open-orders panel as under
  the chart, with the underlying's exposure (Δ sh, $Δ, Γ, Θ/day, Vega/pt) and DTE and Δ per position; a
  click on an option opens its expiry in the chain. Right-click a call or put in the chain for its own
  chart (back on Options the chain is the one it came from). Option risk alerts are in the bell. Always available:
  without OPRA the quotes are delayed.
- **Level 2**: a 5-level book in the order ticket (docked or floating), behind the switch in *Settings ›
  Market Data* (off by default: an open book uses one of the depth lines IB allows per user, 3 by
  default, shared with TWS and other API clients). Tape tests Level 2 when the section opens
  without a Level 2 answer for the connected account (Tape keeps the last check only, so again after you switch
  accounts) and on *Check now*; a full book from IB (no 2152 within a minute) turns it on unless you have set
  the switch yourself, and a book from some exchanges only (IB's 2152, e.g. IEX only) leaves it off, with a
  note under the switch.

**Notifications** — fills, order updates, alerts, option risk alerts and connection
events appear in the bell; each kind can also be pushed to the system notification center, with a sound
switch. Turning off the system notifications of fills, order updates, the connection or option risk asks
first, and so do turning the sound off and choosing *None* for the order or other sounds (critical
notifications then still show, but play no sound). **Do-not-disturb** always ends by itself: it is started for an hour or until 09:00 AM New York time
(there is no "until turned off"), a *DND* tag next to the bell shows while it is on (its tooltip says
when it ends), and critical notifications come through it with their sound: an order rejected, a cancel
or modify IBKR refused, an order the connection lost before IBKR confirmed it, the connection to TWS / IB
Gateway lost (also IB's own link, error 1100) and an option at risk of assignment or a short option losing
its premium. A critical notification also shows as a red message in Tape's window. A do-not-disturb left
on by an older version is turned off on upgrade, with a note in the bell.
On macOS and Windows, orders, fills and everything else each play their own
system sound (chosen in Settings › Notifications, with a sample button; None mutes a category). On macOS
Tape plays the sound itself, so a Focus mode does not mute it; use Tape's do-not-disturb. On Linux the
notification server decides the sound. Clicking a fill opens Portfolio › Trades, an order update Portfolio ›
Orders (not a cancelled or rejected order, which that tab no longer lists: it counts as any other
notification), an option risk alert the option chain; other notifications about an instrument open it in
the chart (from the bell, outside Settings, they only select it).

**Alerts** — moomoo-style alerts on any instrument, from the bell above the chart, a watchlist row's
right-click menu or *Add for …* in the bell. The dialog shows the instrument and, outside regular hours, a
*Pre* / *Post* / *Overnight* tag with that session's price and change, then the alert type, grouped:
- *Uptrend / Downtrend*: rises above / falls below a price, intraday rise / fall exceeds a percent (after
  the close against today's close), 3-minute and 5-minute rise / fall exceeds a percent;
- *Market data*: volume exceeds, turnover exceeds (about volume × the day's VWAP; stocks), bid rises
  above, ask falls below, bid / ask size exceeds. *Turnover ratio* is listed but unavailable: IB does not
  provide shares outstanding;
- *Indicators*: MA and EMA (the price crosses a line, golden / dead cross), MACD (golden / dead cross, DIF
  crosses 0), KDJ (golden / dead cross, K, D or J crosses a level), RSI (crosses a level, golden / dead
  cross) and BOLL (crosses a band), with Futu's default parameters, an interval (1m 5m 15m 30m 1h D W),
  *On bar close* or *Real time*, and a preview of the values the alert tests now;
- *Events*: trading halted / resumed, and *New headline* (stocks): headlines about the stock from the IB
  login's API news feeds, picked as toggles. IBKR includes Briefing.com General Market Columns,
  Briefing.com Analyst Actions and Dow Jones Newsletters by default (a new alert starts with those the login
  has); others are paid API news subscriptions. These are analyst actions, market columns and newsletters, not company
  filings or SEC announcements. The type is offered once Tape knows the login's news providers (connected).

Types an instrument cannot have are greyed out with the reason (no volume for FX, indices and combos,
turnover for stocks only, no bid / ask on indices). Values come with presets (−5 / −2 / +2 / +5 % of the
last price, 1–10 %, multiples of the average volume, 1K / 5K / 10K) and amounts may be typed as *10M*,
*1.5B*, *1000万* or *2亿*; the dialog says how far the market is ("From last +3.31%", "Now +1.24%") and
whether the alert would fire at once. *Frequency*: *Only once* (it then turns itself off), *Once a day*
or *Always on* (every time the condition is met again). US stocks choose their *sessions* (not for news
alerts: a headline is announced whenever it comes). *Remarks* (up to 20 characters) show in the list and
the notification. ⏎ creates or saves, Esc cancels. Mistakes are
shown under their field, and a full limit on the disabled button: 10 alerts of one type per instrument,
200 in all, indicator alerts on at most 20 instrument + interval pairs.

**Managing alerts** — Bell › Alerts lists them by instrument: what each watches, the value now, its
frequency and remarks (a news alert: its providers and the latest headline), and its status: *Paused*,
*Triggered 10:31*, *Delayed 15 min*, *Waiting for 5 min of data*, *Outside selected sessions*, *Checking for
headlines*, or in red when an alert that is on is not being watched (*Not monitored: market data line limit*,
IB's error on the line, delayed data an alert that needs live data waits on, none of a news alert's providers
on this IB login, IB refusing its headline check);
the bell in the top bar then shows a red dot. A click edits an alert (one that is off can be turned on as
it is saved), its switch pauses or resumes it and × deletes it after a confirmation; right-click also
duplicates it or opens its chart. *Delete triggered* removes the one-time alerts that have fired. With more
than 8 alerts the list can show the charted symbol's only. The chart draws a dashed line for price, bid
and ask levels and lights its bell while the symbol has an alert on.

**How alerts are watched** — Tape watches alerts itself, so only while it runs and is connected to TWS /
IB Gateway (on macOS also with the window closed or Tape locked); nothing watches them on a server, and on
Windows and Linux closing the window quits Tape. Each instrument with alerts on holds one of Tape's 95
market data lines; alert lines are the first to go when they run out (the dialog warns above 40).
Price and day-change alerts also fire on delayed data, marked *Delayed 15 min*; 3 / 5-minute, volume,
turnover, bid / ask, size, indicator and halt alerts need live data, and nothing fires on frozen data or
on prices kept from before a disconnect. The change on the day is measured against the previous close,
and after the close against today's close (*after hours*), as the chart header shows. Alerts on US stocks
fire only in their sessions (pre-market, regular and after-hours unless chosen otherwise; IB's overnight
session optional). *Once a day* means once per New York trading day, which begins at 20:00 New York time
(IB's day roll), so midnight where you are does not start a new one. An alert that is already met fires
when it is created or turned on. Indicator alerts read the chart's bars (formulas in
`docs/ARCHITECTURE.md`, *Alerts*); *On bar close* fires when a bar closes (a daily bar at the regular
close, a weekly bar at the regular close of its week's last trading day) and counts in the bar's own
session, so an alert limited to regular hours still fires on the bar that closes at 16:00. News alerts hold no market data line: Tape asks IB for the stock's
latest headlines about every 5 minutes, in the background, and announces those that came after the alert's
first check (*NVDA: new headline — …*, the provider in the text); with several new ones the notification
names the newest and counts the rest. That check is made when the alert is created or turned on, or, while
Tape is disconnected or not yet connected, about 5 s after it connects. Headlines published while Tape is
not running, or before an alert's first check (also during a disconnect), are not announced; those that
come during a later disconnect are, at the next check. At most 20 alert notifications go
out a minute; the rest are folded into one. An alert whose instrument gets none of Tape's 95 market data
lines is reported once.

**API log** — every message sent to and received from TWS / IB Gateway, decoded field by field, with
daily log files, retention and export. A shorter retention deletes the older files right away, so Tape
first says how many files and how much it deletes and asks; turning off the log file asks too (lines
already recorded are still written).

**General** — dark, light or system theme (the dock / window icon follows the theme, and on macOS so does
Tape's icon in Finder), red-up / green-down (CN) or green-up / red-down (US) color convention (a new
profile starts with CN in Chinese and US otherwise), a **color-blind mode**: *Red–green* keeps red and
green but sets them further apart (a teal-leaning green; for color weakness), *Blue–orange* shows blue in
green's place and orange in red's (for red–green color blindness); both keep the convention and draw up
candles hollow, so up and down differ by shape too. English and
中文, and 12-hour ("09:41 AM", "上午 09:41"; the default) or 24-hour ("09:41") clock times everywhere you
read them; the API log and what is sent to IB stay 24-hour. The chart's time axis and crosshair read in a
**chart time zone** of your choice: each instrument's exchange (the default), this computer's, or New
York, Chicago, Los Angeles, London, Frankfurt, Hong Kong, Shanghai, Tokyo, Singapore, Sydney or UTC; the
crosshair shows the full date with its year and weekday ("Tue, Aug 25, 2026 09:30 AM"), and daily and
longer bars keep their trading date in any zone.

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
| Read-Only API | **Off** to place, modify or cancel orders. While it is on, IBKR rejects every order and cancel (error 321, shown with where to turn it off), and Tape shows a red **Read-Only API** chip in the top bar and a warning in the order and cancel dialogs; quotes, account data and positions still work. Tape has no read-only switch of its own: use this one to keep it from trading. |
| Download open orders on connection | On, so working orders show up as soon as Tape connects. |
| Allow connections from localhost only | Recommended. To connect from another machine, turn it off and add that machine under *Trusted IPs*. |

**Overnight-only orders** are routed directly to IBKR's OVERNIGHT venue. With the default API precautions IB
refuses them (error 10329, shown with where to change it): turn on *Bypass Redirect Order warning for Stock API
orders* under *API › Precautions* to send them. Overnight + day orders are SMART-routed and need no change.

**Client ids.** Every program connected to the same TWS / Gateway needs its own client id (Tape uses 7 by
default; change it in *Settings › Connection › Advanced*, or set `TAPE_CLIENT_ID` for a development run). Orders
belong to the client id that placed them, and only that client can modify or cancel them. Orders placed in
IBKR Mobile, Client Portal or TWS come as client 0 with no API order id: cancel them where they were placed, or
with *Portfolio › Orders › Cancel all…*. Client id 0 also takes over orders entered in TWS after it connects.

**Order results.** Tape reports what IBKR answered: an order or modify IBKR has not confirmed within 2 s reads
"Sent #N: IBKR has not confirmed it yet; check Orders" (a refusal that follows is still announced), and an
order the connection lost right after sending it is "not confirmed", never "rejected": check Orders after
reconnecting before sending it again. When one order of a bracket is rejected, Tape cancels the rest (unless
the entry has filled) and says so.

**Connection health.** A connected Gateway can still be unable to pass orders on. When IB Gateway / TWS loses
its own connection to IBKR (IBKR's 1100; 2110 when Tape connects while that is already the case), or stops answering Tape's heartbeat for 10 s (it hangs with its
socket open), the top bar shows a red **IBKR link lost (1100)** or **IB Gateway not responding** chip and
Settings › Connection says the same. Until it is back, orders and modifies are held back (the review cannot
be confirmed, and nothing is sent), while cancels still go out with a warning that they may not arrive. A
Gateway that stays silent for about 40 s is disconnected and, with *Settings › Connection › Auto-reconnect*
on (the default), reconnected automatically (notification *IB Gateway stopped responding*).

**Order review.** Nothing is sent without it, and no setting skips it. Its
title carries a **LIVE** (red) or **PAPER** tag and its first row is the account the order goes to (for a
modify, the order's own account; the id hidden with *Settings › Privacy › Account ID: Hide*; LIVE / PAPER
never is). It lists every attribute, IBKR's
margin and commission estimate for new orders, and in red: prices that are not live (delayed, frozen or none),
IBKR's Read-Only API refusal, and what the pre-trade checks find — a sell that opens or adds to a short
position, a position that turns from long to short (or back), an order worth more than 25% of net
liquidation or more than the buying power it needs (a future's and a written option's margin is left to
IBKR's estimate), a limit more than 5% through the bid / ask (20% for options), and a market order or a
price taken from the bid / ask (followed, or filled from the bid / ask boxes, chips or the Book) while
prices are not live — and what they could not check: positions IBKR has not listed yet (right after
connecting or switching accounts), no account values yet, or no exchange rate from the order's currency
to the account's. Any of those has to be ticked off (*I have checked these warnings*) before Confirm works. A strategy lists every leg as
built ("Sell 1 × AAPL 10/16 230 Put") with the net debit or credit, and a combo at market repeats the
market warning. A modify is titled *Modify order #58*: the rows it changes read before → after and are
marked, what has filled is shown, a modify that changes nothing says so and cannot be confirmed, and an
order that stopped working meanwhile is not reviewed at all. Confirm keeps the focus but arms 0.6 s after
the review opens (or after the tick), so ⏎⏎ or a double-click cannot send an order unread; a cancel,
disconnect or delete confirmation arms the same way, and the rest of a double-click that opened a dialog is
ignored. It opens only while Tape is connected; one open while the connection drops stays (a reconnect to
the same account keeps it) but cannot be confirmed until Tape is connected again. While a dialog is open,
⌘ shortcuts other than ⌘L do nothing.

**Paper or live, always in view.** The top bar shows **LIVE** (red) or **PAPER** with the account Tape
trades (**OFFLINE** while not connected; a click opens Settings › Connection). The first time a connection
lands on a live account (at launch or after a switch, not on a plain reconnect) a notification says
*Connected to LIVE account U…*. Settings › Connection lists every account of a login that manages several
and marks the one orders go to (IBKR's first; Tape does not pick another).

**Switching accounts.** Changing the host, port or client id, or IB Gateway / TWS logging in to another user
on the same port (paper ↔ live), starts afresh: the previous account's orders, trades, positions and account
values are cleared at once, so one account's orders never show (or can be cancelled) under another. An order
review or cancel confirmation opened before the switch closes without sending anything, and the new account's
existing orders and today's fills are not announced as new, and the order ticket starts fresh on the same
instrument (a side or size prepared on paper never waits in the ticket for live). A plain reconnect to the
same account keeps everything. Order, fill and option risk notifications name the account they are about: *Buy 100 AAPL
submitted · PAPER DUP899854* (the id left out with *Settings › Privacy › Account ID: Hide*, also in earlier
notifications; PAPER / LIVE never is). Clicking a fill or order notification of an account that is no
longer connected opens its instrument rather than *Portfolio › Trades / Orders*, which list the connected
account's.

Changing the host, port or client id while Tape is connected (or connecting) asks first: the dialog names
the account being left, says that working orders stay at IB and that Tape can modify or cancel one by one
only the orders of its own client id (those placed with the old one, or in TWS or IBKR Mobile, are then
cancelled there or with *Cancel all orders…*), and says in red when the new port is a live trading port
(4001 or 7496). While disconnected, switching the port to a live one asks too, since the next Connect (or
launch) trades real money, and *Settings › Connection* marks a live port in red under the Port field, as soon as it is typed.
Turning *Auto-reconnect* off asks too: a dropped connection then stays down until you press *Connect*, and a
reconnect under way stops at once.

**Market data sharing and error 10197.** IBKR delivers real-time market data to one session per username.
A paper account receives data only when *Share real-time market data subscriptions with paper trading
account* is enabled for it (Client Portal › Settings › Account Settings › Paper Trading Account), and only
while the live username is not using market data elsewhere. If the live account is logged in on another
device (TWS, Client Portal, IBKR Mobile), the paper session gets error **10197** "No market data during
competing live session", and historical data requests fail with error **162** ("Trading TWS session is
connected from a different IP address"). Log out of the other session, or use a separate username for API
access. Account data, positions, orders and contract search keep working in the meantime, and Tape shows the
reason next to the affected quotes and charts.

**News for alerts.** *New headline* alerts read IBKR's API news, which is set per username and is separate
from the news shown in TWS: Tape lists what IB Gateway / TWS reports for the login (asked once per
connection to an account). When the login has no API news feed, the alert type is greyed out; when IBKR
refuses a feed (for example error **10276** "News feed is not allowed"), the alert shows it in red.

IBKR's own guide: [TWS configuration for API use](https://www.interactivebrokers.com/docs/tws-api/doc/tws-settings/tws-configuration-for-api-use/introduction)
(also under *Help › API settings help*).

## Getting started

```bash
pnpm install
pnpm dev        # Vite dev server + Electron, restarts on main / preload changes
```

Tape connects on launch (Settings › Connection › auto-connect). To try the interface without market data
permissions, run a development build with simulated quotes: `TAPE_DEMO=1 pnpm dev` (ignored by packaged
builds).

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
| `TAPE_DEMO=1` | Development builds only: market data (quotes, bars, depth, option chains) comes from a built-in simulator (ignored when packaged) |
| `TAPE_NO_CONNECT=1` | Do not auto-connect on launch |
| `TAPE_CLIENT_ID=<n>` | Override the API client id |
| `TAPE_USER_DATA=<dir>` | Use a separate profile directory |
| `TAPE_OUT=<dir>` | Build into `<dir>` instead of `out` (absolute, or relative to the repository; `main`, `preload` and `renderer` all go there) |
| `TAPE_CAPTURE_DIR`, `TAPE_CAPTURE_STEPS`, `TAPE_CAPTURE_QUIT` | Scripted screenshots, see `src/main/devCapture.ts` |
| `TAPE_FAKE_BIOMETRICS=[touchId:\|windowsHello:]ok\|fail\|cancel\|unavailable` | Development builds only: a fake Touch ID / Windows Hello that never shows a system prompt (ignored when packaged) |
| `TAPE_LIVE_IB=<host:port>` | Enables `src/main/ib/live.test.ts`, which connects to a logged-in **paper** TWS / IB Gateway (set `TAPE_CLIENT_ID` to an unused id); it reads the login's API news providers and AAPL's latest headlines, places a BUY 1 AAPL limit order at 1.00 and cancels it |

`scripts/capture.ts` wraps the capture variables for a built app:
`node scripts/capture.ts --out out --dir /tmp/shots --steps steps.json [--demo] [--connect --client-id <n>]`.

## Data on disk

Everything is stored locally in the user data folder (macOS `~/Library/Application Support/Tape`,
Windows `%APPDATA%\Tape`, Linux `~/.config/Tape`):

| File | Contents |
| --- | --- |
| `settings.json` | Settings (validated on load; unknown keys are dropped) |
| `watchlists.json` | Watchlists and groups |
| `alerts.json` | Alerts: rule, frequency, sessions, note and on / off. Price alerts are also written in the format Tape 0.12 reads, and alerts of a newer version are kept as written (not run here) |
| `notifications.json` | The last 200 notifications |
| `window.json` | Window position and size |
| `lock.json` | The lock PIN as a salted scrypt hash and the count of wrong PINs (mode 0600; never the PIN itself) |
| `tape.db` | SQLite database (with `-wal` / `-shm` files) caching market data from IB: bars, contract details and option chain parameters; seconds bars expire after 6 days, minute bars after 30, 30-minute and hour bars after 400, other entries after 180 days. Tape keeps no trade or account history of its own (older versions kept net liquidation samples and an executions journal here; they are dropped on upgrade) |

JSON files are written atomically. A file that cannot be read is kept as `<name>.corrupt-<timestamp>.json`
and the defaults are used instead; an unreadable `tape.db` is moved aside as `tape.db.corrupt-<timestamp>`
and recreated. API log files (`api-YYYYMMDD.log`) go to the system log folder (macOS
`~/Library/Logs/Tape`) and are deleted after the retention period chosen in *Settings › Logs* (at each
launch, and right away, after a confirmation, when the period is shortened).

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
- **Signing.** electron-builder signs with a code signing identity from your keychain when it finds one;
  otherwise the app keeps the ad-hoc signature made right after the fuses are flipped (an unsigned build with
  flipped fuses is killed at launch on Apple Silicon). Hardened runtime and notarization are off for local
  builds; to distribute, use a Developer ID certificate (`CSC_NAME` / `CSC_LINK`), enable `hardenedRuntime`
  and configure notarization.
  macOS only delivers system notifications from signed apps.

## Project structure

```
src/
  shared/      types, IPC contract (TapeApi / TapeEvent), formatting and contract helpers, defaults,
               indicators and live bars (shared by the chart and the alerts)
  main/        Electron main process
    index.ts         services, window, IPC handlers
    store.ts         JSON persistence (storeSchema.ts validates, jsonFile.ts writes atomically)
    db/              tape.db: SQLite (node:sqlite) in a worker thread, in-memory fallback
    ib/              connection, account, orders, API log
      tws/           dependency-free TWS API client: socket, encoder / decoder, send queue, pacing
    market/          contracts, quotes, history, depth, options, alerts engine, news for alerts, demo simulator
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
  details; turn off *Also write to log file* in *Settings › Logs* if you do not want them on disk.

## Lock screen

The lock screen is a privacy lock for Tape's window: it hides balances, positions and orders and refuses
everything a user would do (orders, settings, watchlists, alerts, logs) until the PIN is entered.

- **Lock** with ⌘L / Ctrl+L, the padlock in the top bar or *Tape › Lock Tape*. The first time, Tape asks for
  a PIN and locks once it is saved. *Settings › Privacy & Security* sets the idle time (15 / 30 / 60 minutes,
  custom or never; no keyboard or mouse input on the computer, checked every 15 s), the unlock method, the
  lock sound, and changes or removes the PIN. Tape starts locked whenever a PIN is set (silently).
- **Lock sound**: a soft two-part click on unlock (high, then low), and the same click backwards when Tape
  locks (low, then high), however it locked: the padlock, ⌘L, the menu or the idle time. One switch, *Lock
  sound*, turns both off.
- **Weakening the lock needs the PIN**: a longer idle time (or never), and Touch ID / Windows Hello where
  *PIN only* was chosen, are saved only after the current PIN is entered (the main process checks it; Touch
  ID cannot stand in here). A shorter idle time, *PIN only* and the sound change at once. This keeps a
  passer-by at an unlocked Tape from turning the lock off in one click; it is not a boundary, since
  `settings.json` can be edited by your user account.
- **Notifications while locked**: system notifications say only what happened (*New fill*, *Order
  rejected*, *Order needs attention*, *Alert triggered*, *1 new notification*), never the symbol, side,
  quantity or price; the bell keeps the full text for after the unlock.
- **PIN**: exactly 6 characters of any kind (letters are case-sensitive; digits, symbols and other scripts
  work; spaces and control characters do not). It is only stored as a salted scrypt hash in `lock.json`.
  After 5 wrong PINs in a row Tape waits 30 s before the next attempt, doubling up to 15 minutes; the count
  survives a restart. If `lock.json` cannot be read (damaged, or blocked by permissions), Tape stays locked
  and accepts no PIN; *Forgot PIN?* is the way out.
- **What keeps running**: IB Gateway / TWS stays connected, market data keeps flowing, orders already sent
  keep working on IB's servers and alerts keep firing.
- **What it does not protect**: IB Gateway / TWS stays logged in and accepts any local API client, so anyone
  at the computer can still use IBKR through another program, and the files in the user data folder are
  readable by your user account. *Forgot PIN?* needs no PIN either: anyone at the computer can reset Tape
  (losing its local data) and connect it to the running IB Gateway again. Use the lock as a privacy screen;
  to prevent trading, lock the computer itself or log out of IB Gateway. *Settings › Privacy & Security* and
  the *Reset Tape* dialog say so too.
- **Forgot PIN?** The PIN cannot be recovered. *Reset Tape* on the lock screen (type RESET / 重置) deletes all of
  Tape's local data: settings, watchlists, alerts, notifications, API logs, the PIN, the database
  (market data caches) and the window position; only the language and the theme are kept. Tape then
  restarts like a fresh install, on *Settings › Connection*, without connecting. Your IBKR account,
  positions and orders on IB's servers are not affected.
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
