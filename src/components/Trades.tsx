"use client";

import { memo } from "react";
import { useStore } from "zustand";
import { store } from "@/lib/store";
import type { TradeSlot } from "@/lib/types";
import type { RowKind } from "./Row";

/** Recent fills, newest first; same fixed-slot discipline as the book. */
export function Trades() {
  const trades = useStore(store, (s) => s.trades);
  const kindOf = (slot: TradeSlot): RowKind => (slot.px ? "level" : trades[0].px ? "empty" : "skeleton");
  return (
    <div data-testid="trades">
      {trades.map((t, i) => (
        <TradeRow key={i} kind={kindOf(t)} px={t.px} sz={t.sz} time={t.time} side={t.side} flashSeq={t.flashSeq} />
      ))}
    </div>
  );
}

const TradeRow = memo(function TradeRow({ kind, px, sz, time, side, flashSeq }: Omit<TradeSlot, "flashSeq"> & { kind: RowKind; flashSeq: number }) {
  const flashClass = flashSeq ? ` flash-${side === "buy" ? "up" : "down"}-${flashSeq & 1 ? "a" : "b"}` : "";
  return (
    <div className={`row${flashClass}`} data-kind={kind}>
      <span className={`px ${side}`}>{px}</span>
      <span className="sz">{sz}</span>
      <span className="total text-muted">{time}</span>
    </div>
  );
});
