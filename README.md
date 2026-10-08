# Hyperliquid Order Book

**Live demo:** https://hyperliquid-widget.vercel.app · code: https://github.com/BZahory/hyperliquid-widget

A live BTC / ETH perpetuals order book (with a recent-trades tab) driven by Hyperliquid's mainnet
`l2Book` and `trades` WebSocket feeds. Next.js (App Router) + React + TypeScript + Tailwind +
zustand, nothing else at runtime.

```sh
pnpm install && pnpm dev     # http://localhost:3000
```

Other commands: `pnpm test` (vitest: derive math, the store merge, socket lifecycle against a fake
WebSocket) · `pnpm verify` (Playwright against a running dev server, or `URL=https://… pnpm verify`
against a deployment; once: `pnpm exec playwright install chromium`) · `pnpm probe` (re-check the
live API assumptions below) · `pnpm knip` · `pnpm lint` · `pnpm typecheck` · `pnpm build`.

## Data flow

```
wss://api.hyperliquid.xyz/ws
        │  l2Book snapshots + trades batches (strings on the wire)
        ▼
src/lib/socket.ts   module-level manager: registry keyed by subscription identity
        │           (l2Book: coin + nSigFigs + fast; trades: coin), routes by channel + coin,
        │           drops data until the subscribe ACK, 2s watchdog (10s stale, 30s ping), backoff+jitter
        │           reconnect (≤10s), resubscribe-all on open, offline/online/visibility listeners
        ▼
src/lib/store.ts    two latest-wins slots (fast top-5 feed, deep 20-level feed) + a capped
        │           newest-first trade list ──► ONE requestAnimationFrame ──► commit()
        ▼
src/lib/derive.ts   mergeSnapshots() + deriveBook(): parse once to bigint fixed-point, exact
        │           cumulative sums, one max shared by both sides, change flashes, preformatted
        │           strings; deriveTrades(): same for the trades tab
        ▼
zustand vanilla store (one setState per frame)
        ▼
src/components/Book.tsx → 2 × 12 fixed slots → <Row> (memo, primitive props)
src/components/Trades.tsx → 25 fixed slots → <TradeRow> (memo)
```

Where the perf-sensitive choices live:

| Concern | Where |
| --- | --- |
| React renders at most once per frame regardless of message rate | `store.ts` — `schedule()` / `flush()`: one rAF, latest snapshot wins |
| All parsing/formatting happens once, outside components | `derive.ts`; components receive strings and 0..1 ratios (`types.ts`) |
| No float in any displayed decimal | `derive.ts` — wire strings parse to `bigint` at scale 8, so sums and size × price are exact; `Intl.NumberFormat` formats the resulting decimal strings exactly. Only bar ratios and the power-of-ten grouping step are floats |
| Tooltips cost no renders | `Row.tsx` renders each row's tooltip with the row; `globals.css` `.row:hover > .tip` shows it. Full values are native `title`s |
| Zero wasted renders | ≤ 1 commit per frame (~1.85/s, one per fast snapshot); header, controls and menus don't re-render in steady state. `Row.tsx` — `memo` with primitive props, so a row renders only when its props change (most do each tick: totals and the shared max move); `verify.mjs` counts Row fibers that rendered vs. whose props changed via the React DevTools commit hook |
| Depth bars never trigger layout | `globals.css` `.bar` — `transform: scaleX()` with a 120 ms linear transition |
| Zero layout shift | fixed 32 px rows (22 px below 900 px viewport height), fixed grid columns, `font-variant-numeric: tabular-nums` (checked in `verify.mjs`) |
| Flashes cost no renders | `derive.ts` counts each slot's flashes into a number prop that changes only when the row's size or price does anyway; `Row.tsx` alternates two identical animations by its parity, so a new flash restarts without remounting. A tab switch clears the counts, so remounted rows don't replay them |
| Exactly one `useEffect` | `OrderBook.tsx` — boots the idempotent data layer; symbol/precision/unit changes are plain actions |

## What the API actually does (measured on mainnet)

`scripts/probe-ws.mjs` re-checks the snapshot shape, ACKs, fast cadence and stragglers.

- Each `l2Book` message is a full snapshot: `{coin, time, levels: [bids desc, asks asc]}`, `px`/`sz`
  strings, `n` number. State is replaced wholesale every frame; there is no diff engine.
- `subscriptionResponse` echoes a *normalised* subscription (adds `mantissa: null`, `fast: false`),
  so ACKs are matched on our own fields, never deep-equal. A duplicate subscribe returns an
  `error` channel message.
- **`nSigFigs` accepts 2–5** or omission (full precision); 1 and 6 are rejected. All work on the
  fast, deep and HTTP paths for BTC and ETH. At current prices 5 returns the same levels as full
  precision, plus a `spread` field.
- **Two cadences.** The default subscription sends 20 levels per side but only every ~5 s. The
  [documented](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)
  `fast: true` option sends ~2 snapshots per second but only the top 5 levels per side. The
  widget subscribes to both and merges them: the fast top-5 verbatim, then the levels strictly
  beyond them from the previous merge (reset to the deep snapshot whenever one lands), so a level
  leaving the fast window keeps its last fast size instead of reverting. The top of the book is
  always fresh; deeper rows refresh every few seconds. The deep ladder spans only ~$19 on BTC, so a bigger move empties the
  tail of one side; the store then refetches 20 levels over HTTP (`POST /info` `l2Book`, ~200 ms,
  one in flight, ~1/s) and shows skeletons meanwhile: a short side lasts one round trip, or ~1 s
  under the throttle; a failed request falls back to the next deep snapshot (≤ ~5 s).
- **Stragglers.** `l2Book` messages do not echo `nSigFigs`; after a precision change on the same
  coin, snapshots at the old grouping can still arrive. Flipping precision every 900 ms for 10
  rounds showed they arrive only *before* the new subscription's ACK, never after. Each registry
  entry therefore drops data until its ACK, with a 5 s fail-open so a lost ACK can't freeze the
  book: well above a slow link's round trip, and inside the 10 s watchdog, so it never forces a
  reconnect. Switching coins needs no gate: routing is by coin, so late messages find no entry. Known
  gap: re-selecting a grouping whose earlier ACK is still in flight (three switches inside one
  round trip) lets that ACK open the gate early, so a frame or two of the middle grouping can show.
- The `trades` subscription sends a batch of the 30 most recent fills on subscribe (oldest →
  newest), then small incremental batches. Fields: `coin, side ("B" buy / "A" sell), px, sz, time,
  hash, tid, users`. The widget keeps the newest 25, flashing only fresh fills.
- A silent connection is closed by the server after 60 s (measured: close code 1006 at 60.4 s), so
  a `{"method":"ping"}` goes out every 30 s. A 2 s watchdog force-drops the socket if no snapshot
  arrived in 10 s (live gaps peak at ~1.1 s fast, ~5.9 s deep), so a stalled socket shows "live"
  for at most ~12 s — pongs deliberately don't count, because they prove the socket, not the
  subscription. "Live" is set when snapshots reach the book, not when the socket opens; the backoff
  (≤ 10 s) resets only after 10 s of steady data, so a server that drops right after a snapshot
  backs off instead of looping; a handshake that hangs is abandoned after 10 s; a tab becoming
  visible runs the watchdog or retries a pending reconnect at once, and `online` replaces the
  socket outright. Any transition away from live clears both buffers so a pre-disconnect deep
  snapshot is never merged with fresh data.

## Reading the book

Matches the reference design (header card with the market, max leverage and a market menu;
"Orders | Trades" tabs; asks above, pinned spread row, bids below, depth bars from the left;
grouping and unit controls above the book) and then adds what a trader actually reads from a book:

- **Cumulative depth bars** scaled against one max shared by both sides, so a longer bid bar really
  means more resting size than the asks.
- **Spread row** with absolute and percentage spread.
- **Change flashes**: a level whose size at least doubles or halves (or that appears) by at least
  two average levels of its side lights its whole row in its side's colour, fading out over 250 ms.
  Replaying 18 min of mainnet (six BTC and ETH recordings), any change would flash 7–9 of the 10
  fast rows per frame, and doubling or halving alone 2.5–6.5, since a dust order at a new price is a
  100% change; with the size floor it is 0.15–1.2 per frame (a busy minute of BTC live: ~1.5), each
  fast row every ~4–30 s. Only the fast top-5 flash (deeper rows change in ~5 s batches, which is
  batching, not news), and never on a first snapshot, a tab or market switch, a reconnect, or a
  level that merely scrolled into view.
- Depth bars and totals follow the selected unit (base asset or USD notional).
- **Sweep highlight** on hover: every level between the touch and the cursor lights up, i.e. what a
  market order of that depth would eat. Pure CSS (`:hover ~` for asks, `:has(~ :hover)` for bids).
- **Hover tooltip** with what that sweep means: its total at full precision in the selected unit
  and its average fill price (marked `≈` when grouped, since grouped levels are bucket prices, not
  real ones). Beside the card on wide screens; above asks and below bids on narrow ones, so it
  never covers the highlighted range.
- **Full values on hover**: every price, size, total and spread cell reveals its unrounded value
  in the selected unit (a native `title`; the spread %, a non-terminating ratio, to 8 decimals).
  USD values and the spread % are marked `≈` when grouped.
- **Grouping as price steps.** The control above the book shows the current step (e.g. `10`) and
  the dropdown lists the `nSigFigs` options (2–5, then full precision) by the step each produces at
  the current price, derived from Hyperliquid's tick rules (≤5 significant figures, ≤ 6 − szDecimals
  decimals, integers always allowed): at current prices `1,000 · 100 · 10 · 1` for BTC and
  `100 · 10 · 1 · 0.1` for ETH. Each step is listed once: where 5 gives the same step as full
  precision (it does for both today), it is the same book, so only full precision is offered. Sizes
  can be shown in USD or the base asset.
- Prices show the decimals of the step, not of whichever prices are on screen, so columns keep
  their width; a USD size under half a dollar reads `<1`, not `0`.
- **Trades tab**: the most recent fills, newest first, price coloured by taker side, with a flash on
  each new fill.
- Loading skeleton on every switch, a status dot by the market name (connecting / live /
  reconnecting / offline) that also dims the panel when it isn't live, keyboard-navigable menus
  and tabs (WAI-ARIA select-only combobox, tablist, radio group).

## Libraries

- **Next.js / React / TypeScript** — required. The page is a static shell; the widget is one client
  component. `cacheComponents`, `partialPrefetching` and the React Compiler were removed from the
  generated config: a single static page with no server data gains nothing from them, and explicit
  `memo` keeps the re-render story inspectable.
- **Tailwind v4** for layout utilities; the row geometry, bars, skeleton, hover and tooltip rules are
  plain CSS in `globals.css`, where they're easier to read as one unit.
- **zustand (vanilla store)** — an external store the data layer can write to from a rAF callback,
  consumed with `useStore` selectors so the header, book and controls each re-render only for the
  slice they read. No provider, no reducers.
- Dev only: **vitest** (unit tests), **Playwright** (real-browser verification), **knip** (dead code).

## Verification

`pnpm verify` drives Chromium against live mainnet and checks: the book renders and visibly updates;
changed rows flash, about one per frame, and not on a tab or market switch; a row's tooltip shows on
hover, on screen, with no float artefacts; number cells reveal their full values; memoized rows
render only when their props change; digits are tabular and rows share one height; the precision
dropdown regroups prices; switching symbol clears old rows synchronously and shows the new book;
menus close on outside click; keyboard selection works; DevTools-style offline → status `offline` →
online → status `live` and data resumes without reload; zero console errors.

## Next steps

- Mark deep rows that are older than the fast top-5 (a subtle text dim).
- Check `src/lib/assets.ts`'s `szDecimals` and max leverage against the `meta` endpoint in CI. The
  asset list is permissioned: adding a symbol is an entry there plus its mark in `CoinIcon` (a type
  error until both exist), and its menu entry follows.
