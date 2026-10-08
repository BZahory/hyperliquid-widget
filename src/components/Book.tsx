"use client";

import { memo } from "react";
import { useStore } from "zustand";
import { store } from "@/lib/store";
import { Row, type RowKind } from "./Row";
import type { Slot } from "@/lib/types";

/** Re-renders once per committed frame; unchanged rows bail out via memo. */
export function Book() {
  const book = useStore(store, (s) => s.book);
  const loading = useStore(store, (s) => s.loading);
  const unit = useStore(store, (s) => (s.quote ? "USD" : s.coin));
  // Missing levels are loading until the first deep snapshot; after that the side has no more.
  const kind: RowKind = loading ? "skeleton" : "empty";

  const row = (side: "ask" | "bid", slot: Slot, i: number) => (
    <Row key={i} side={side} kind={slot.px ? "level" : kind} unit={unit} {...slot} />
  );

  return (
    <div data-testid="book" data-loading={loading || undefined}>
      {/* Keyed by slot index, never price. */}
      <div className="asks" data-testid="asks">
        {book.asks.map((slot, i) => row("ask", slot, i)).reverse()}
      </div>
      <div className="row bg-line" data-testid="spread">
        <LastPrice />
        <span className="sz" title={book.spreadFull || undefined}>
          <span className="text-muted">Spread</span>
          {/* Reserves room so the label never moves. */}
          <span className="flex min-w-[4ch] justify-end">{book.spread}</span>
        </span>
        <span className="total" title={book.spreadPctFull || undefined}>{book.spreadPct}</span>
      </div>
      <div className="bids" data-testid="bids">
        {book.bids.map((slot, i) => row("bid", slot, i))}
      </div>
    </div>
  );
}

/** Last trade price (exact in any grouping, unlike a bucket mid); its own subscriber, so fills render only it. */
const LastPrice = memo(function LastPrice() {
  const px = useStore(store, (s) => s.trades[0]?.px);
  const full = useStore(store, (s) => s.trades[0]?.pxFull);
  return (
    <span className="px text-base leading-none" title={full} data-testid="last">
      {px}
    </span>
  );
});
