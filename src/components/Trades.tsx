"use client";

import { memo, useCallback, useLayoutEffect, useRef, type CSSProperties } from "react";
import { useStore } from "zustand";
import { TRADES } from "@/lib/derive";
import { holdTrades, scrollTrades, store } from "@/lib/store";
import type { TradeSlot } from "@/lib/types";
import { unpin } from "./Row";

/** Rows rendered past each edge of the view. */
const OVERSCAN = 5;

const SKELETON = Array.from({ length: TRADES }, (_, i) => (
  <div key={i} className="row" data-kind="skeleton" aria-hidden="true">
    <span />
    <span className="sz" />
    <span className="total" />
  </div>
));

/** Virtualized fill history, keyed by fill and placed by transform, so fills and scrolls never re-render shown rows. */
export function Trades() {
  const trades = useStore(store, (s) => s.trades);
  const top = useStore(store, (s) => s.tradesTop);
  const scroller = useRef<HTMLDivElement>(null);
  /** Row height in px; it follows the viewport, so it's measured on resize. */
  const row = useRef(0);

  const attach = useCallback((el: HTMLDivElement) => {
    scroller.current = el;
    const measure = () => (row.current = el.querySelector(".row")?.getBoundingClientRect().height || el.clientHeight / TRADES);
    const sync = () => scrollTrades(Math.floor(el.scrollTop / row.current), Math.floor(el.clientHeight / row.current));
    measure();
    const resize = new ResizeObserver(() => {
      measure();
      sync();
    });
    resize.observe(el);
    el.addEventListener("scroll", sync, { passive: true });
    return () => {
      resize.disconnect();
      el.removeEventListener("scroll", sync);
    };
  }, []);

  // Before paint, move the scroll position to the store's first row.
  useLayoutEffect(() => {
    const el = scroller.current!;
    el.scrollTop += (top - Math.floor(el.scrollTop / row.current)) * row.current;
  }, [top]);

  /** Tell the store whether a row has focus; also after each render, as a row leaving the DOM may not blur. */
  const hold = () => {
    const el = scroller.current!;
    holdTrades(el !== document.activeElement && el.contains(document.activeElement));
  };
  useLayoutEffect(hold);

  const start = Math.max(0, top - OVERSCAN);
  return (
    <div className="relative">
      <div
        ref={attach}
        role="list"
        aria-label="Recent trades"
        tabIndex={0}
        data-testid="trades"
        onFocus={hold}
        onBlur={hold}
        onKeyDown={(e) => {
          // Scrolling keys act on the list, not a focused row that would scroll out of the DOM.
          if (["Home", "End", "PageUp", "PageDown", " "].includes(e.key)) e.currentTarget.focus({ preventScroll: true });
          // Jump, not smooth-scroll: fills landing mid-scroll would move the target.
          if (e.key === "Home") {
            e.preventDefault();
            e.currentTarget.scrollTop = 0;
          }
        }}
        className="trades outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70"
      >
        {trades.length ? (
          <div className="relative" style={{ height: `calc(var(--fill) * ${trades.length})`, "--head": trades[0].seq } as CSSProperties}>
            {trades.slice(start, top + TRADES + OVERSCAN).map((t) => (
              <TradeRow key={t.id} {...t} />
            ))}
          </div>
        ) : (
          SKELETON
        )}
      </div>
      {/* Back to the newest, floating at the bottom middle of the view. */}
      {top > 0 && (
        <button
          type="button"
          onClick={() => (scroller.current!.scrollTop = 0)}
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full border border-line bg-[#1b1e21] px-2.5 py-0.5 text-xs shadow-lg outline-hidden focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          ↑ Latest
        </button>
      )}
    </div>
  );
}

/** A fill, linking to its transaction on the explorer when it has one. */
const TradeRow = memo(function TradeRow({ seq, px, sz, time, side, pxFull, szFull, href }: TradeSlot) {
  const cells = (
    <>
      <span className={`px ${side}`} title={pxFull}>{px}</span>
      <span className="sz" title={szFull}>{sz}</span>
      <span className="total text-muted">{time}</span>
    </>
  );
  return (
    <div role="listitem" className="fill" style={{ "--seq": seq } as CSSProperties}>
      {href ? (
        <a className="row" data-kind="level" href={href} target="_blank" rel="noopener noreferrer" tabIndex={-1} onMouseLeave={unpin}>
          {cells}
        </a>
      ) : (
        <div className="row" data-kind="level">
          {cells}
        </div>
      )}
    </div>
  );
});
