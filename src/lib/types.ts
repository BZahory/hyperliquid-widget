/**
 * Wire types: exactly what Hyperliquid puts on the socket. Every numeric is a
 * string here and is parsed exactly once, in `derive.ts`.
 */
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

export type Coin = "BTC" | "ETH";
/** `nSigFigs` of the l2Book subscription; null = full precision. */
export type NSigFigs = null | 5 | 4 | 3 | 2;

/**
 * Display types: preformatted strings and 0..1 ratios. Components render these
 * verbatim and never parse or format.
 */
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

export interface DisplayBook {
  /** Exactly DEPTH slots each, index 0 = best price. Short sides are padded with empty slots. */
  asks: Slot[];
  bids: Slot[];
  spread: string;
  spreadPct: string;
  /** Smallest gap between adjacent levels — the effective price grouping. */
  tick: string;
  /** Share of displayed depth sitting on the bid side, 0..1. */
  bidShare: number;
  bidPct: string;
  askPct: string;
}
