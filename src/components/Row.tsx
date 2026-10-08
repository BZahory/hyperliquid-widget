import { memo } from "react";
import type { Slot } from "@/lib/types";

export type RowKind = "level" | "empty" | "skeleton";

type RowProps = Slot & {
  side: "ask" | "bid";
  kind: RowKind;
};

/** One fixed slot with primitive props, so unchanged rows skip the render. */
export const Row = memo(function Row({ side, kind, px, sz, total, ratio, flash }: RowProps) {
  return (
    <div className={`row ${side}${flash ? ` flash-${flash & 1 ? "a" : "b"}` : ""}`} data-kind={kind}>
      <div className="bar" style={{ transform: `scaleX(${ratio})` }} />
      <span className="px">{px}</span>
      <span className="sz">{sz}</span>
      <span className="total">{total}</span>
    </div>
  );
});
