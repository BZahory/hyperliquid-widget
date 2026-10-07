import { memo } from "react";
import type { Flash } from "@/lib/types";

export type RowKind = "level" | "empty" | "skeleton";

interface RowProps {
  side: "ask" | "bid";
  kind: RowKind;
  px: string;
  sz: string;
  total: string;
  ratio: number;
  flash: Flash;
  flashSeq: number;
}

/** One fixed slot. Primitive props only, so unchanged rows bail out of every frame's render. */
export const Row = memo(function Row({ side, kind, px, sz, total, ratio, flash, flashSeq }: RowProps) {
  const flashClass = flash ? ` flash-${flash}-${flashSeq & 1 ? "a" : "b"}` : "";
  return (
    <div className={`row ${side}${flashClass}`} data-kind={kind}>
      <div className="bar" style={{ transform: `scaleX(${ratio})` }} />
      <span className="px">{px}</span>
      <span className="sz">{sz}</span>
      <span className="total">{total}</span>
    </div>
  );
});
