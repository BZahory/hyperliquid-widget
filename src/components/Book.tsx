"use client";

import { useStore } from "zustand";
import { store } from "@/lib/store";
import { Row, type RowKind } from "./Row";
import type { Slot } from "@/lib/types";

function kindOf(slot: Slot, loading: boolean): RowKind {
  return slot.px ? "level" : loading ? "skeleton" : "empty";
}

/** The live part: re-renders once per committed frame; unchanged rows bail out via memo. */
export function Book() {
  const book = useStore(store, (s) => s.book);
  const loading = useStore(store, (s) => s.loading);
  const stale = useStore(store, (s) => s.status !== "live");

  const row = (side: "ask" | "bid", slot: Slot, i: number) => (
    <Row
      key={i}
      side={side}
      kind={kindOf(slot, loading)}
      px={slot.px}
      sz={slot.sz}
      total={slot.total}
      ratio={slot.ratio}
      flash={slot.flash}
      flashSeq={slot.flashSeq}
    />
  );

  return (
    <div className={`book${stale ? " stale" : ""}`} data-testid="book" data-loading={loading || undefined}>
      {/* Asks: worst at the top, best touching the spread. Slot index is the key, never price. */}
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
      <div
        className="flex items-center gap-3 px-4 py-2 text-xs"
        role="meter"
        aria-label="Depth imbalance"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={book.bidShare}
        aria-valuetext={book.bidPct ? `${book.bidPct} bids, ${book.askPct} asks` : "no data"}
      >
        <span className="w-9 text-bid">{book.bidPct}</span>
        <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-ask/35">
          <div
            className="absolute inset-0 origin-left bg-bid transition-transform duration-300 ease-out"
            style={{ transform: `scaleX(${book.bidShare})` }}
          />
        </div>
        <span className="w-9 text-right text-ask">{book.askPct}</span>
      </div>
    </div>
  );
}
