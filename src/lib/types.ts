/** Wire shapes as Hyperliquid sends them: every numeric is a string, parsed once in derive.ts. */
export interface WireLevel {
  px: string;
  sz: string;
  n: number;
}

export interface WireL2Book {
  coin: string;
  time: number;
  /** [bids descending, asks ascending] — a full snapshot every message. */
  levels: [WireLevel[], WireLevel[]];
  /** Present (true) only on messages from a `fast: true` subscription. */
  fast?: boolean;
}

/** One fill from the `trades` channel. Batches arrive oldest → newest. */
export interface WireTrade {
  coin: string;
  /** "B" = buyer was the taker, "A" = seller was. */
  side: "A" | "B";
  px: string;
  sz: string;
  time: number;
  tid: number;
}

export type Coin = "BTC" | "ETH";
/** `nSigFigs` of the l2Book subscription; null = full precision. */
export type NSigFigs = null | 5 | 4 | 3 | 2;

/** Display shapes: preformatted strings and 0..1 ratios; components never parse or format. */
export type Flash = "" | "up" | "down";

export interface Slot {
  px: string;
  sz: string;
  total: string;
  /** Cumulative size / max cumulative across both sides. */
  ratio: number;
  flash: Flash;
  /** Increments on every flash at this slot; parity alternates the CSS animation name so it restarts. */
  flashSeq: number;
}

/** A precision option labelled by the price step it produces at the current price. */
export interface Grouping {
  value: NSigFigs;
  label: string;
}

export interface TradeSlot {
  px: string;
  sz: string;
  time: string;
  side: "buy" | "sell" | "";
  /** Increments when a fresh trade lands in this slot, so only new fills animate, not shifted ones. */
  flashSeq: number;
}

export interface DisplayBook {
  /** Exactly DEPTH slots each, index 0 = best price. Short sides are padded with empty slots. */
  asks: Slot[];
  bids: Slot[];
  spread: string;
  spreadPct: string;
  /** Price step of the current grouping. */
  tick: string;
  /** Coarse → fine, ending with full precision; options no coarser than full precision are left out. */
  groupings: Grouping[];
}
