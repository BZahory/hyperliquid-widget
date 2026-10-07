"use client";

import { useStore } from "zustand";
import { store } from "@/lib/store";
import { Row, type RowKind } from "./Row";
import type { Slot } from "@/lib/types";

/** BTC/ETH books are never thinner than DEPTH, so a missing level is always data still on its way. */
const kindOf = (slot: Slot): RowKind => (slot.px ? "level" : "skeleton");

/** The live part: re-renders once per committed frame; unchanged rows bail out via memo. */
export function Book() {
  const book = useStore(store, (s) => s.book);
  const loading = useStore(store, (s) => s.loading);

  const row = (side: "ask" | "bid", slot: Slot, i: number) => (
    <Row
      key={i}
      side={side}
      kind={kindOf(slot)}
      px={slot.px}
      sz={slot.sz}
      total={slot.total}
      ratio={slot.ratio}
      flash={slot.flash}
      flashSeq={slot.flashSeq}
    />
  );

  return (
    <div data-testid="book" data-loading={loading || undefined}>
      {/* Asks: best price touches the spread. Slot index is the key, never price. */}
      <div className="asks" data-testid="asks">
        {book.asks.map((slot, i) => row("ask", slot, i)).reverse()}
      </div>
      <div className="row bg-[#2a2d31] text-muted" data-testid="spread">
        <span className="px">Spread</span>
        <span className="sz">{book.spread}</span>
        <span className="total">{book.spreadPct}</span>
      </div>
      <div className="bids" data-testid="bids">
        {book.bids.map((slot, i) => row("bid", slot, i))}
      </div>
    </div>
  );
}
