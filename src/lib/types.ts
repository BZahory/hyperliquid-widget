/** Wire shapes as Hyperliquid sends them; prices and sizes are strings. */
export interface WireLevel {
  px: string;
  sz: string;
  n: number;
}

export interface WireL2Book {
  coin: string;
  time: number;
  /** [bids descending, asks ascending]; every message is a full snapshot. */
  levels: [WireLevel[], WireLevel[]];
  /** Only on `fast: true` messages. */
  fast?: boolean;
  /** Only on grouped messages: the true spread. */
  spread?: string;
}

/** One fill; batches arrive oldest → newest. */
export interface WireTrade {
  coin: string;
  /** "B" = buyer was the taker, "A" = seller was. */
  side: "A" | "B";
  px: string;
  sz: string;
  time: number;
  /** All zeros for TWAP and liquidation fills. */
  hash: string;
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

export interface TradeSlot {
  /** The fill's `tid`, keying its row. */
  id: number;
  /** Arrival order; a row sits (newest seq − seq) rows down. */
  seq: number;
  px: string;
  sz: string;
  time: string;
  side: "buy" | "sell";
  /** Full values for hover. */
  pxFull: string;
  szFull: string;
  /** Explorer link, "" when the fill has no transaction. */
  href: string;
}

export interface DisplayBook {
  /** DEPTH slots each, index 0 = best price. */
  asks: Slot[];
  bids: Slot[];
  spread: string;
  spreadPct: string;
  /** Full values for hover; the % is "≈" when grouped. */
  spreadFull: string;
  spreadPctFull: string;
  /** Bids' share of the displayed depth. */
  bidShare: number;
  /** Price step of the current grouping. */
  tick: string;
  /** Coarse → fine, each step once. */
  groupings: Grouping[];
}
