/** Wire shapes as Hyperliquid sends them: prices and sizes are strings (`n`, `time` are numbers),
 *  parsed in derive.ts. */
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
  /** Present only on grouped (`nSigFigs`) messages: the true full-precision spread. */
  spread?: string;
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

/** `nSigFigs` of the l2Book subscription (the API rejects 1 and 6); null = full precision. */
export type NSigFigs = null | 5 | 4 | 3 | 2;

/** Display shapes: preformatted strings and 0..1 ratios; components never parse or format. */
export interface Slot {
  px: string;
  sz: string;
  total: string;
  /** Cumulative size / max cumulative across both sides. */
  ratio: number;
  /** Full values for hover, in the selected unit; "≈" on grouped USD values. */
  pxFull: string;
  szFull: string;
  totalFull: string;
  /** Tooltip: average fill of a sweep to here. */
  avg: string;
  /** Flash count; its parity alternates two identical animations so a flash restarts without remounting. */
  flash: number;
}

/** A grouping option labelled by its price step. */
export interface Grouping {
  value: NSigFigs;
  label: string;
}

/** A fill's flash: its taker side. */
type Flash = "" | "up" | "down";

export interface TradeSlot {
  px: string;
  sz: string;
  time: string;
  side: "buy" | "sell" | "";
  /** Full values for hover. */
  pxFull: string;
  szFull: string;
  /** Set when a fresh trade lands here and kept as rows shift, so a shifted row never restarts it. */
  flash: Flash;
  /** Increments when a fresh trade lands in this slot, so only new fills animate, not shifted ones. */
  flashSeq: number;
}

export interface DisplayBook {
  /** Exactly DEPTH slots each, index 0 = best price. Short sides are padded with empty slots. */
  asks: Slot[];
  bids: Slot[];
  spread: string;
  spreadPct: string;
  /** Full values for hover; the % is "≈" when grouped. */
  spreadFull: string;
  spreadPctFull: string;
  /** Price step of the current grouping. */
  tick: string;
  /** Coarse → fine, each step once. */
  groupings: Grouping[];
}
