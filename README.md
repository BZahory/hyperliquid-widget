# Hyperliquid Order Book

**Live demo:** __LIVE_URL__

A live BTC / ETH perpetuals order book driven by Hyperliquid's mainnet `l2Book` WebSocket
feed. Next.js (App Router) + React + TypeScript + Tailwind + zustand, nothing else at runtime.

```sh
pnpm install && pnpm dev     # http://localhost:3000
```

Other commands: `pnpm test` (vitest, pure flush math) · `pnpm verify` (Playwright against a running
dev server, or `URL=https://… pnpm verify` against a deployment) · `pnpm probe` (re-check the live
API assumptions below) · `pnpm knip` · `pnpm lint` · `pnpm typecheck` · `pnpm build`.

## Data flow

```
wss://api.hyperliquid.xyz/ws
        │  l2Book snapshots (strings on the wire)
        ▼
src/lib/socket.ts   module-level manager: registry keyed by (coin, nSigFigs, fast), routes by
        │           (coin, fast), drops data until the subscribe ACK, 30s ping + 45s watchdog,
        │           backoff+jitter reconnect, resubscribe-all on open, offline/online listeners
        ▼
src/lib/store.ts    two latest-wins slots (fast top-5 feed, deep 20-level feed)
        │           ──► ONE requestAnimationFrame ──► commit()
        ▼
src/lib/derive.ts   mergeSnapshots() + deriveBook(): parse once, cumulative sums, one max shared
        │           by both sides, per-slot change detection, preformatted strings
        ▼
zustand vanilla store (one setState per frame)
        ▼
src/components/Book.tsx → 2 × 11 fixed slots → <Row> (memo, primitive props)
```

Where the perf-sensitive choices live:

| Concern | Where |
| --- | --- |
| React renders at most once per frame regardless of message rate | `store.ts` — `schedule()` / `flush()`: one rAF, latest snapshot wins |
| All parsing/formatting happens once, outside components | `derive.ts`; components receive strings and 0..1 ratios (`types.ts`) |
| Unchanged rows bail out | `Row.tsx` — `memo` with primitive props; `verify.mjs` counts Row fibers that rendered vs. whose props changed via the React DevTools commit hook |
| Depth bars never trigger layout | `globals.css` `.bar` — `transform: scaleX()` with a 120 ms linear transition |
| Zero layout shift | fixed 24 px rows, fixed grid columns, `font-variant-numeric: tabular-nums` (checked in `verify.mjs`) |
| Flashes restart without remounting | `Row.tsx` alternates `flash-up-a` / `flash-up-b` by `flashSeq` parity; state persists on the slot until the next change there |
| Exactly one `useEffect` | `OrderBook.tsx` — boots the idempotent data layer; symbol/precision/unit changes are plain actions |

## What the API actually does (verified with `scripts/probe-ws.mjs`)

- Each `l2Book` message is a full snapshot: `{coin, time, levels: [bids desc, asks asc]}`, `px`/`sz`
  strings, `n` number. State is replaced wholesale every frame; there is no diff engine.
- `subscriptionResponse` echoes a *normalised* subscription (adds `mantissa: null`, `fast: false`),
  so ACKs are matched on our own fields, never deep-equal. A duplicate subscribe returns an
  `error` channel message.
- **Two cadences.** The default subscription sends 20 levels per side but only every ~5 s. Adding
  `fast: true` (accepted and echoed by the server) sends ~2 snapshots per second but only the top
  5 levels per side. The widget subscribes to both and merges them: the fast top-5 verbatim, then
  the deep snapshot's levels strictly beyond them. The top of the book is always fresh; deeper rows
  refresh every few seconds. After a sharp move the deep tail can briefly show a price gap until
  the next deep snapshot fills it in.
- **Stragglers.** `l2Book` messages do not echo `nSigFigs`; after a precision change on the same
  coin, snapshots at the old grouping can still arrive. Flipping precision every 900 ms for 10
  rounds showed they arrive only *before* the new subscription's ACK, never after. Each registry
  entry therefore drops data until its ACK (with a 2 s fail-open so a lost ACK can't freeze the
  book). Switching coins needs no gate: routing is by coin, so late messages find no entry.
- Idle connections are closed after 60 s: a `{"method":"ping"}` goes out every 30 s. The same timer
  force-drops the socket if nothing at all (not even a `pong`) arrived in 45 s, which is what a
  half-open socket after laptop sleep looks like.

## Reading the book

Matches the reference design (dark terminal, asks above, pinned spread row, bids below, depth
bars from the left) and then adds what a trader actually reads from a book:

- **Cumulative depth bars** scaled against one max shared by both sides, so a longer bid bar really
  means more resting size than the asks.
- **Spread row** with absolute and percentage spread.
- **Change flashes** on the size cell: green when size at a level grew (or a new level appeared),
  red when it shrank. One-shot; a finished flash is never re-triggered by unrelated renders.
- **Imbalance meter** under the book: share of displayed depth on each side.
- **Sweep highlight** on hover: every level between the touch and the cursor lights up, i.e. what a
  market order of that depth would eat. Pure CSS (`:hover ~` for asks, `:has(~ :hover)` for bids).
- **Grouping shown as a price step** in the footer (e.g. `10`), computed from the live snapshot,
  with the `nSigFigs` options in the dropdown. Sizes can be shown in USD or the base asset.
- Loading skeleton on every switch, status pill (connecting / live / reconnecting / offline) that
  dims the book when it isn't live, keyboard-navigable dropdowns (WAI-ARIA select-only combobox).

## Libraries

- **Next.js / React / TypeScript** — required. The page is a static shell; the widget is one client
  component. `cacheComponents`, `partialPrefetching` and the React Compiler were removed from the
  generated config: a single static page with no server data gains nothing from them, and explicit
  `memo` keeps the re-render story inspectable.
- **Tailwind v4** for layout utilities; the row geometry, bars, flashes and hover rules are ~60 lines
  of plain CSS where they're easier to read as one unit.
- **zustand (vanilla store)** — an external store the data layer can write to from a rAF callback,
  consumed with `useStore` selectors so the header, book and footer each re-render only for the
  slice they read. No provider, no reducers.
- Dev only: **vitest** (flush math), **Playwright** (real-browser verification), **knip** (dead code).

## Verification

`pnpm verify` drives Chromium against live mainnet and checks: the book renders and visibly
updates; flashes appear; memoized rows render only when their props change; digits are tabular and
rows share one height; the precision dropdown regroups prices; switching symbol clears old rows
synchronously and shows the new book; keyboard selection works; DevTools-style offline → status
`offline` → online → status `live` and data resumes without reload; zero console errors.

## Next steps

- Mark deep rows that are older than the fast top-5 (a subtle text dim) and fill the gap after a
  sharp move from the `bbo` or `trades` channel instead of waiting for the next deep snapshot.
- Fetch `szDecimals` from the `meta` endpoint to support any coin instead of a two-entry table.
- Test the socket manager against a scripted mock server (reconnect, ACK gate, watchdog); today
  those paths are exercised only by the Playwright offline/online cycle.
- `prefers-reduced-motion` to disable flashes and bar glides.
