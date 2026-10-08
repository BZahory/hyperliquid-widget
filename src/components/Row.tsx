import { memo } from "react";
import type { Slot } from "@/lib/types";

export type RowKind = "level" | "empty" | "skeleton";

type RowProps = Slot & {
  side: "ask" | "bid";
  kind: RowKind;
  /** Selected unit, for the tooltip's label. */
  unit: string;
};

/** One fixed slot with primitive props, so unchanged rows skip the render; the tooltip is shown by CSS. */
export const Row = memo(function Row({ side, kind, unit, px, sz, total, ratio, pxFull, szFull, totalFull, avg, flash }: RowProps) {
  return (
    <div className={`row ${side}${flash ? ` flash-${flash & 1 ? "a" : "b"}` : ""}`} data-kind={kind}>
      <div className="bar" style={{ transform: `scaleX(${ratio})` }} />
      <span className="px" title={pxFull || undefined}>{px}</span>
      <span className="sz" title={szFull || undefined}>{sz}</span>
      <span className="total" title={totalFull || undefined}>{total}</span>
      {kind === "level" && (
        <div className="tip" role="tooltip">
          <span className="k">Total ({unit})</span>
          <span>{totalFull}</span>
          <span className="k">Avg price</span>
          <span>{avg}</span>
        </div>
      )}
    </div>
  );
});
