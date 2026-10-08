# Hyperliquid Order Book

**Live demo:** https://hyperliquid-widget.vercel.app · code: https://github.com/BZahory/hyperliquid-widget

A live BTC / ETH perpetuals order book (with a recent-trades tab) driven by Hyperliquid's mainnet
`l2Book` and `trades` WebSocket feeds. Each symbol has its own route (`/btc`, `/eth`; `/` redirects
to `/btc`). Next.js (App Router) + React + TypeScript + Tailwind + zustand, nothing else at runtime.

```sh
pnpm install && pnpm dev     # http://localhost:3000
```

Other commands: `pnpm test` (vitest: derive math, the store merge, disconnect and refill guards, the
trade history and its scroll, socket lifecycle against a fake WebSocket) · `pnpm verify` (Playwright
against a running dev server, or `URL=https://… pnpm verify` against a deployment; once: `pnpm exec
playwright install chromium`) · `pnpm probe` (re-check the `l2Book` assumptions below) · `pnpm knip`
· `pnpm lint` · `pnpm typecheck` · `pnpm build`.

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
src/lib/store.ts    two latest-wins slots (fast top-5 feed, deep 20-level feed), each snapshot checked
        │           against the grouping, + a newest-first history of 500 fills, + the trades scroll
        │           ──► ONE requestAnimationFrame ──► commit()
        ▼
src/lib/derive.ts   mergeSnapshots() + deriveBook(): parse once to bigint fixed-point, exact
        │           cumulative sums, one max shared by both sides, change flashes, preformatted
        │           strings; deriveTrades(): same for each new fill, once
        ▼
zustand vanilla store (one setState per frame)
        ▼
src/components/Book.tsx → 2 × 12 fixed slots → <Row> (memo, primitive props)
src/components/Trades.tsx → scroller, rows in view + 5 either side → <TradeRow> (memo, keyed by tid)
```

Where the perf-sensitive choices live:

| Concern | Where |
| --- | --- |
| React renders at most once per frame regardless of message rate | `store.ts` — `schedule()` / `flush()`: one rAF, latest snapshot wins |
| A long trade history costs little | `store.ts` derives each fill once, on arrival (the whole history only on a unit change or after a reconnect); `Trades.tsx` renders only the rows in view and 5 either side, keyed by `tid` and placed by CSS from their arrival order, so a fill or a scroll renders only the rows it brings into view; a scroll commits with the next frame's data |
| All parsing/formatting happens once, outside components | `derive.ts`; components receive strings and 0..1 ratios (`types.ts`) |
| No float in any displayed decimal | `derive.ts` — wire strings parse to `bigint` at scale 8, so sums and size × price are exact; `Intl.NumberFormat` formats the resulting decimal strings exactly. Only bar ratios and the power-of-ten grouping step are floats |
| Tooltips cost no renders | `Row.tsx` renders each row's tooltip with the row; `globals.css` `.row:is(:hover, :focus) > .tip` shows it. Full values are native `title`s |
| Flashes cost no renders | `derive.ts` counts each slot's flashes into a number prop that changes only when the row's size or price does anyway; `Row.tsx` alternates two identical animations by its parity, so a new flash restarts without remounting. A tab switch clears the counts, so remounted rows don't replay them |
| Zero wasted renders | ≤ 1 commit per frame (one per fast snapshot, ~2/s); header, controls and menus don't re-render in steady state (the header's imbalance bar does, by design). `Row.tsx` — `memo` with primitive props, so a row renders only when its props change (most do each tick: totals and the shared max move); the spread row's last price is its own `memo` subscriber, so only a new last price renders it; `verify.mjs` watches React DevTools' commit hook and fails if a Row renders with unchanged props or gets an object or function prop, or the last price renders unchanged |
| Depth bars never trigger layout | `globals.css` `.bar` — `transform: scaleX()` with a 120 ms linear transition |
| Zero layout shift | `globals.css` `.row` — one row height from the viewport (32 px down to 16 px, so the whole widget fits from ~640 px tall: a 768 px screen's browser viewport; a plain fallback where `round()` doesn't parse), grid tracks that never grow to fit content, right-aligned sizes and totals, `tabular-nums`. The trades list moves its rows by `transform` (`.fill`), never layout. `verify.mjs` fails on any layout-shift entry without recent input that moves the panel (the hover tooltip, an overlay, is exempt: it resizes with its values) |
| Exactly one effect in the widget shell | `OrderBook.tsx` — a layout effect points the data layer at the route's coin before paint (so the old coin's book never shows under the new header) and boots it, idempotently; precision/unit changes are plain actions. `Trades.tsx` adds two layout effects, one moving the scroll position with the store before paint and one telling the store whether a row has focus, and attaches its scroll and resize listeners in a ref callback. In dev, editing `store.ts` or anything it imports reloads the page instead of hot-swapping a module that owns the live socket |

## What the API actually does (measured on mainnet)

`scripts/probe-ws.mjs` re-checks the snapshot shape, ACKs, fast cadence and stragglers on the fast
and deep BTC feeds.

- Each `l2Book` message is a full snapshot: `{coin, time, levels: [bids desc, asks asc]}`, `px`/`sz`
  strings, `n` number. Each message replaces its feed's buffer wholesale; there is no diff engine.
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
  leaving the fast window keeps its last fast size instead of reverting. When grouped, a deep book
  at another step than the fast one (the price crossed a power of ten between them) is not merged:
  its buckets would overlap. The top of the book is always fresh; deeper rows refresh every few
  seconds. The deep ladder spans only ~$19 on BTC, so a move drains the tail of one side; once a
  side is down to 15 levels the store refetches 20 over HTTP (`POST /info` `l2Book`, ~300 ms
  including the CORS preflight, one in flight, ~1/s, 2 s timeout), and back to back while a row is
  blank, since in a fast move a reply can land short already. That fills most gaps before a row
  empties, not all: the fast top-5 can jump past the end of the deep ladder in one frame. Live, BTC
  shows a blank row 6–8% of the time (~15 times a minute, each under ~0.7 s; 25–32 requests a
  minute), ETH 1–2%. A side whose deep snapshot has under 20 levels has no more (e.g. coarse
  grouping at BTC 100k–120k): no refetch, blank rows.
  It waits for the first deep snapshot (which follows the fast one by milliseconds), and a reply
  older than the deep snapshot, or from before a switch or a disconnect, is dropped.
- **Stragglers.** `l2Book` messages do not echo `nSigFigs`; after a precision change on the same
  coin, snapshots at the old grouping can still arrive, mostly before the new subscription's ACK but
  sometimes after it (the probe sees 2–3 in about a quarter of 30-switch runs). Each registry entry
  drops data until its ACK, with a 5 s fail-open so a lost ACK can't freeze the book: well above a
  slow link's round trip, and inside the 10 s watchdog, so it never forces a reconnect. The store
  then drops any snapshot whose data isn't at the grouping: only grouped books carry `spread`, and a
  grouped book's prices sit on its step and no coarser one. Switching coins needs neither: routing
  is by coin, so late messages find no entry.
- The `trades` subscription sends a batch of the 30 most recent fills on subscribe (oldest →
  newest), then small incremental batches. Fields: `coin, side ("B" buy / "A" sell), px, sz, time,
  hash, tid, users`; ~4 fills a second on BTC, ~2 on ETH (60 s, measured). The widget keeps the newest
  500. `hash` is the fill's transaction; TWAP and liquidation fills (15–25% of them) carry an all-zero
  hash, for which the explorer has only "This fill was part of a TWAP or liquidation".
- A silent connection is closed by the server after 60 s (measured: close code 1006 at 60.4 s), so
  a `{"method":"ping"}` goes out every 30 s. A 2 s watchdog force-drops the socket if no snapshot
  arrived in 10 s (live gaps peak at ~1.1 s fast, ~5.9 s deep), so a stalled socket shows "live"
  for at most ~12 s — pongs deliberately don't count, because they prove the socket, not the
  subscription. "Live" is set when snapshots reach the book, not when the socket opens; the backoff
  (≤ 10 s) resets only after 10 s of steady data, so a server that drops right after a snapshot
  backs off instead of looping; a handshake that hangs is abandoned after 10 s; a tab becoming
  visible runs the watchdog or retries a pending reconnect at once, and `online` replaces the
  socket outright. Any transition away from live marks both buffers stale: the last book and trades
  stay on screen (greyed, and still re-derivable in the other unit), and the first message after
  the drop clears them, so a pre-disconnect deep snapshot is never merged with fresh data. The book
  waits for the new deep snapshot (milliseconds behind the fast one) before replacing the old one,
  so a reconnect never shows the fast top-5 alone.

## Reading the book

Matches the reference design (header card with the market, max leverage and a market menu;
"Orders | Trades" tabs; asks above, pinned spread row, bids below, depth bars from the left;
grouping and unit controls, here in a footer below the book) and then adds what a trader actually
reads from a book:

- **Cumulative depth bars** scaled against one max shared by both sides, so a longer bid bar really
  means more resting size than the asks. They glide (120 ms) as sizes change.
- **Imbalance bar** along the header's bottom edge: green for the bids' share of the displayed depth,
  red for the asks', moving with every book frame on both tabs.
- **Change flashes**: a level whose size at least doubles or halves (or that appears) by at least
  two average levels of its side lights its whole row in its side's colour, fading out over 250 ms.
  Replaying 18 min of mainnet (six BTC and ETH recordings), any change would flash 7–9 of the 10
  fast rows per frame, and doubling or halving alone 2.5–6.5, since a dust order at a new price is a
  100% change; with the size floor it is 0.15–1.2 per frame (a busy minute of BTC live: ~1.5), each
  fast row every ~4–30 s. Only the fast top-5 flash (deeper rows change in ~5 s batches, which is
  batching, not news), and never on a first snapshot, a tab or market switch, a reconnect, or a
  level that merely scrolled into view.
- **Spread row** with the last trade price, large (exact in every grouping, unlike a grouped book's
  bucket mid), then absolute and percentage spread.
- Depth bars and totals follow the selected unit (base asset or USD notional).
- **Sweep highlight** on hover: every level between the touch and the cursor lights up, i.e. what a
  market order of that depth would eat. Pure CSS (`:hover ~` for asks, `:has(~ :hover)` for bids).
  Rows are focusable but not tab stops, so the same shows for a tapped row on a touch screen (until
  the next tap) and from the keyboard: focus the panel, then the arrow keys walk the rows.
- **Hover tooltip** with what that sweep means: its total at full precision in the selected unit
  and its average fill price (marked `≈` when grouped, since grouped levels are bucket prices, not
  real ones). Beside the card on wide screens; above asks and below bids on narrow ones, so it
  never covers the highlighted range.
- **Full values on hover**: every price, size, total and spread cell reveals its unrounded value
  in the selected unit (a native `title`; the spread %, a non-terminating ratio, to 8 decimals).
  USD values and the spread % are marked `≈` when grouped.
- **Grouping as price steps.** The footer control shows the current step (e.g. `Grouping 10`) and
  the dropdown lists the `nSigFigs` options (2–5, then full precision) by the step each produces at
  the current price, derived from Hyperliquid's tick rules (≤5 significant figures, ≤ 6 − szDecimals
  decimals, integers always allowed): at current prices `1,000 · 100 · 10 · 1` for BTC and
  `100 · 10 · 1 · 0.1` for ETH. Each step is listed once: where 5 gives the same step as full
  precision (it does for both today), it is the same book, so only full precision is offered. Sizes
  can be shown in USD or the base asset.
- Prices show the decimals of the step, not of whichever prices are on screen, so columns keep
  their width; a USD size under half a dollar reads `<1`, not `0`.
- **Trades tab**: the last 500 fills, newest first, price coloured by taker side, scrolling in the
  book's height. At the top, new fills show live; scrolled down, or with a row focused from the
  keyboard, they land above the view without moving the rows being read, and "↑ Latest" at the
  bottom of the list goes back. A fill opens its transaction on the Hyperliquid explorer in a new tab
  (marked ↗ on hover or keyboard focus); TWAP and liquidation fills have none, so they are plain
  rows. The list is a tab stop: Page Up/Down scroll it, Home goes to the newest, the arrow keys walk
  its rows from the first in view, Enter opens one. The header's imbalance strip keeps moving when
  fills pause.
- Loading skeleton on every market or grouping switch, a status dot by the market name (connecting / live /
  reconnecting / offline); when the feed drops, the subtitle reads "Reconnecting…" or "Offline" and
  the panel greys out, still readable at AA contrast (and is back in full as soon as data returns).
  Keyboard-navigable menus, tabs and tab panel (WAI-ARIA select-only combobox, tablist, radio group);
  text meets WCAG AA (the accent has a lighter text shade); footer hit areas of 24 px (44 px on
  touch screens); focus rings, depth bars, the status dot and skeletons survive Windows high-contrast
  mode.

## Libraries

- **Next.js / React / TypeScript** — required. `src/app/[coin]/page.tsx` prerenders one static page
  per permissioned symbol (`generateStaticParams`; any other path is a 404), and the market menu
  navigates between them; the widget is one client component, its labels read from the route.
  `cacheComponents`, `partialPrefetching` and the React Compiler were removed from the generated
  config: static pages with no server data gain nothing from them, and explicit `memo` keeps the
  re-render story inspectable.
- **Tailwind v4** for layout utilities; the row geometry, bars, skeleton, hover and tooltip rules are
  plain CSS in `globals.css`, where they're easier to read as one unit.
- **zustand (vanilla store)** — an external store the data layer can write to from a rAF callback,
  consumed with `useStore` selectors so the header, book and controls each re-render only for the
  slice they read. No provider, no reducers.
- No virtualization library: rows are one height (a CSS variable), so the window is an array slice
  and a transform per row; `@tanstack/react-virtual` would add a dependency for measuring we don't
  need.
- Dev only: **vitest** (unit tests), **Playwright** (real-browser verification), **knip** (dead code).

## Verification

`pnpm verify` drives Chromium against live mainnet and checks: the book renders and visibly updates;
changed rows flash, about one per frame, and not on a tab or market switch; the spread row shows the
last trade price; a row's tooltip shows on hover and from the keyboard, on screen, with no float
artefacts; number cells reveal their full values; memoized rows render only when their props change,
and the last price only when it changes; digits are tabular, rows share one height and the whole
card fits both a 1000 px and a 640 px tall viewport (a 768 px screen's browser); the precision
dropdown regroups prices; picking a market navigates to its route with the old rows already cleared,
then shows the new book; the imbalance bar moves; the Trades tab lists fills; its history scrolls in
the book's height with only the rows in view and 5 either side in the DOM; while it scrolls and
fills stream in, trade rows render only as they enter the view, at most one commit a frame; fills
landing above a scrolled view don't move the row being read in any frame, and "↑ Latest" goes back;
the end of the history stays filled as fills land; the list is reachable, scrolls and walks its rows
from the keyboard; a fill opens its transaction on the live explorer; a focused fill stays focused
and in place as fills land, and Home goes back to live; the market menu closes on outside click;
keyboard selection works; text on a hovered depth bar, the spread row and a tooltip measures AA
contrast in rendered pixels, live and greyed; DevTools-style offline → "Offline" shown, the unit
still switches (focus kept) → online → status `live` and data resumes without reload; no layout
shift moves the panel; zero console errors.

## Next steps

- Mark deep rows that are older than the fast top-5 (a subtle text dim).
- Check `src/lib/assets.ts`'s `szDecimals` and max leverage against the `meta` endpoint in CI. The
  asset list is permissioned: adding a symbol is an entry there plus its mark in `CoinIcon` (a type
  error until both exist), and its route and menu entry follow.
