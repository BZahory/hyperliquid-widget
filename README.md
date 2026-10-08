# Hyperliquid Order Book

**Live demo:** https://hyperliquid-widget.vercel.app · **Code:** https://github.com/BZahory/hyperliquid-widget

A live order book and trade feed for Hyperliquid's BTC and ETH perpetuals, at `/btc` and `/eth`.

```sh
pnpm install && pnpm dev    # http://localhost:3000
pnpm test                   # unit tests (vitest)
pnpm verify                 # Playwright on a running app (:3000, or URL=https://…), live data
```

## Stack

Next.js 16 (App Router, static pages) · React 19 · TypeScript · Tailwind v4 · zustand. Nothing else
ships to the browser. Vitest, Playwright and knip for checks; deployed on Vercel.

## Architecture

```
          Hyperliquid mainnet
   WebSocket                    HTTP POST /info
   l2Book (fast top 5, ~2/s)    l2Book refill when
   l2Book (deep 20, ~5 s)       a side runs short
   trades                              │
      │                                │
      ▼                                │
socket.ts   one socket: subscriptions, ACK gate,
      │     watchdog, ping, reconnect with backoff
      ▼                                │
store.ts    latest-wins buffers ◄──────┘
      │     ──► one requestAnimationFrame per frame
      ▼
derive.ts   merge fast + deep, bigint math, depth,
      │     flashes, preformatted strings
      ▼
zustand     one setState per frame
      │
      ├──► Book    24 fixed memoised rows (asks, spread, bids)
      ├──► Trades  virtualized list of 500 fills
      └──► Header  market menu (navigates /btc ↔ /eth), imbalance strip

app/[coin]/page.tsx   prerendered per symbol; the route sets the store's coin
lib/assets.ts         the permissioned asset list (decimals, leverage, colour)
```

## Key decisions

- **One render per frame.** Messages only fill buffers, and a single `requestAnimationFrame`
  derives and commits, so React renders at most once per frame at any message rate.
- **Two book feeds, merged.** The fast feed is fresh but only 5 levels deep; the deep feed has 20
  levels but updates every ~5 s. The top comes from the fast feed, the rest from the deep one, and
  a short side refills over HTTP.
- **Exact numbers.** Wire strings parse to fixed-point `bigint`s, so totals and USD values never
  pick up float errors. Every rounded number reveals its exact value on hover.
- **Components never compute.** `derive.ts` hands them preformatted strings and 0–1 ratios. Rows
  take only primitive props, so `memo` skips any row that didn't change.
- **CSS does the motion.** Depth bars move by `transform`, flashes are CSS animations, and hover
  highlights and tooltips are pure CSS. Hovering never renders, and nothing shifts layout.
- **Flash only meaningful changes.** A row flashes in its side's colour when its level's size at
  least doubles or halves by a real amount, so dust orders don't flicker the book.
- **Virtualized trades.** 500 fills are kept, each formatted once on arrival. Only the visible rows
  are rendered, and the scroll position holds while new fills land above.
- **Robust feed.** Data is ignored until each subscription is confirmed, and snapshots at the wrong
  price grouping are dropped, since old-grouping data can trail a switch. A watchdog reconnects a
  silent socket, and the last data stays on screen, greyed, while the feed is down.
- **The URL owns the market.** Each symbol is a prerendered route, and the layout effect switches
  the data layer before paint, so the old book never shows under the new header.
- **A permissioned asset list.** Adding a market means one entry in `src/lib/assets.ts` plus its
  icon; the route, menu entry and accent colour follow.

## Testing

`pnpm test` covers the derive math, the store and the socket lifecycle. `pnpm verify` checks the
live app in Chromium. It fails on wasted renders, layout shift, contrast below WCAG AA and broken
interactions, and it also exercises an offline/online cycle. `pnpm probe` re-checks the API
behaviour the design relies on.
