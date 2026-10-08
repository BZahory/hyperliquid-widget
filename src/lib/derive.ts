import type { DisplayBook, Grouping, NSigFigs, Slot, TradeSlot, WireL2Book, WireLevel, WireTrade } from "./types";

/** Rows per side. Fixed so the DOM never changes shape. */
export const DEPTH = 12;
/** Rows in the trades tab: the same height as both sides of the book plus the spread row. */
export const TRADES = DEPTH * 2 + 1;
/** A level flashes when its size changes by ≥ FLASH_PCT% and by ≥ FLASH_AVGS average levels of its side;
 *  the size floor keeps dust orders (a 100% change) from flashing every frame (see README). */
const FLASH_PCT = 50;
const FLASH_AVGS = 2;

export interface DeriveOptions {
  szDecimals: number;
  nSigFigs: NSigFigs;
  /** Show size/total/depth in quote currency (USD) instead of base. */
  quote: boolean;
}

const EMPTY_SLOT: Slot = { px: "", sz: "", total: "", ratio: 0, flash: 0 };

export const EMPTY_BOOK: DisplayBook = {
  asks: Array<Slot>(DEPTH).fill(EMPTY_SLOT),
  bids: Array<Slot>(DEPTH).fill(EMPTY_SLOT),
  spread: "",
  spreadPct: "",
  tick: "",
  groupings: [],
};

const EMPTY_TRADE: TradeSlot = { px: "", sz: "", time: "", side: "", flash: "", flashSeq: 0 };
export const EMPTY_TRADES: TradeSlot[] = Array<TradeSlot>(TRADES).fill(EMPTY_TRADE);

const formatters = new Map<number, Intl.NumberFormat>();
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function fmt(n: number, decimals: number): string {
  let f = formatters.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    formatters.set(decimals, f);
  }
  return f.format(n);
}

/** Significant fractional digits of a wire price: "83452.0" → 0, "2568.1" → 1. */
function fracDigits(px: string): number {
  const dot = px.indexOf(".");
  if (dot < 0) return 0;
  let end = px.length;
  while (end > dot + 1 && px.charCodeAt(end - 1) === 48 /* '0' */) end--;
  return end - dot - 1;
}

/** Price step of a grouping from Hyperliquid's tick rules (≤5 significant figures, ≤ 6 − szDecimals
 *  decimals, integers always allowed). Deterministic, unlike level gaps, which widen when a book thins. */
function tickOf(price: number, nSigFigs: NSigFigs, szDecimals: number): number {
  const digits = Math.floor(Math.log10(price)) + 1;
  if (nSigFigs !== null) return 10 ** (digits - nSigFigs);
  return Math.max(Math.min(10 ** (digits - 5), 1), 10 ** (szDecimals - 6));
}

const fmtTick = (tick: number) => fmt(tick, Math.max(0, -Math.round(Math.log10(tick))));

/** Grouping options by step, coarse → fine, each step once; reuses `prev` when unchanged to avoid renders. */
function groupingsAt(price: number, szDecimals: number, prev: Grouping[]): Grouping[] {
  const full = tickOf(price, null, szDecimals);
  const next: Grouping[] = [];
  for (const n of [2, 3, 4, 5] as const) {
    const tick = tickOf(price, n, szDecimals);
    if (tick > full) next.push({ value: n, label: fmtTick(tick) });
  }
  next.push({ value: null, label: fmtTick(full) });
  const same = prev.length === next.length && next.every((g, i) => g.label === prev[i].label);
  return same ? prev : next;
}

interface Side {
  px: number[];
  sz: number[];
  /** Cumulative size in base units, and in quote units (Σ size × price). */
  cum: number[];
  cumQuote: number[];
  pxDecimals: number;
}

function parseSide(wire: WireLevel[]): Side {
  const levels = wire.slice(0, DEPTH);
  const px = levels.map((l) => Number(l.px));
  const sz = levels.map((l) => Number(l.sz));
  const cum: number[] = [];
  const cumQuote: number[] = [];
  let acc = 0;
  let accQuote = 0;
  let pxDecimals = 0;
  for (let i = 0; i < levels.length; i++) {
    acc += sz[i];
    accQuote += sz[i] * px[i];
    cum.push(acc);
    cumQuote.push(accQuote);
    pxDecimals = Math.max(pxDecimals, fracDigits(levels[i].px));
  }
  return { px, sz, cum, cumQuote, pxDecimals };
}

/** What a frame is compared with to find changed levels. */
export interface Change {
  /** The previous full snapshot, so a level scrolling into view isn't new. */
  before: WireL2Book;
  /** Fast-feed levels per side [bids, asks]; only these flash (deeper rows change in ~5 s batches). */
  live: [number, number];
}

function buildSlots(side: Side, bids: boolean, max: number, pxDecimals: number, opts: DeriveOptions, prev: Slot[], change: Change | null): Slot[] {
  const cum = opts.quote ? side.cumQuote : side.cum;
  const decimals = opts.quote ? 0 : opts.szDecimals;
  const before = change?.before.levels[bids ? 0 : 1] ?? [];
  const sizes = new Map(before.map((l) => [Number(l.px), Number(l.sz)]));
  const edge = before.length ? Number(before[before.length - 1].px) : undefined;
  const live = change?.live[bids ? 0 : 1] ?? 0;
  const floor = FLASH_AVGS * (side.cum[side.cum.length - 1] ?? 0);
  const slots = new Array<Slot>(DEPTH);
  for (let i = 0; i < DEPTH; i++) {
    if (i >= side.px.length) {
      slots[i] = EMPTY_SLOT;
      continue;
    }
    const size = side.sz[i];
    // An unknown price is new inside last frame's range, but beyond it is only newly learned depth.
    let flash = prev[i].flash;
    if (i < live) {
      const inside = edge !== undefined && (bids ? side.px[i] > edge : side.px[i] < edge);
      const was = sizes.get(side.px[i]) ?? (inside ? 0 : size);
      const delta = Math.abs(size - was);
      if (delta * 100 >= FLASH_PCT * Math.max(size, was) && delta * side.sz.length >= floor) flash++;
    }
    slots[i] = {
      px: fmt(side.px[i], pxDecimals),
      sz: fmt(opts.quote ? size * side.px[i] : size, decimals),
      total: fmt(cum[i], decimals),
      ratio: cum[i] / max,
      flash,
    };
  }
  return slots;
}

/** Merge the two cadences: fast top-of-book verbatim, then deep levels strictly beyond the last fast
 *  price on each side. Overlapping deep levels are dropped as up to ~5s older than the fast ones. */
export function mergeSnapshots(fast: WireL2Book | null, deep: WireL2Book | null): WireL2Book | null {
  if (!fast || !deep) return fast ?? deep;
  const tail = (top: WireLevel[], rest: WireLevel[], bids: boolean) => {
    if (!top.length) return rest;
    const edge = Number(top[top.length - 1].px);
    return top.concat(rest.filter((l) => (bids ? Number(l.px) < edge : Number(l.px) > edge)));
  };
  return {
    coin: fast.coin,
    time: fast.time,
    levels: [tail(fast.levels[0], deep.levels[0], true), tail(fast.levels[1], deep.levels[1], false)],
    spread: fast.spread,
  };
}

/** Sums, shared max, change detection and formatting in one pass; with no `change` nothing flashes. */
export function deriveBook(snap: WireL2Book, prev: DisplayBook, opts: DeriveOptions, change: Change | null = null): DisplayBook {
  const bids = parseSide(snap.levels[0]);
  const asks = parseSide(snap.levels[1]);
  const depthOf = (s: Side) => (opts.quote ? s.cumQuote : s.cum)[s.cum.length - 1] ?? 0;
  const bidDepth = depthOf(bids);
  const askDepth = depthOf(asks);
  const max = Math.max(bidDepth, askDepth) || 1;
  const pxDecimals = Math.max(bids.pxDecimals, asks.pxDecimals);

  let spread = "";
  let spreadPct = "";
  let tick = "";
  let groupings = prev.groupings;
  const ref = bids.px.length && asks.px.length ? (bids.px[0] + asks.px[0]) / 2 : (bids.px[0] ?? asks.px[0]);
  if (ref !== undefined) {
    tick = fmtTick(tickOf(ref, opts.nSigFigs, opts.szDecimals));
    groupings = groupingsAt(ref, opts.szDecimals, prev.groupings);
    if (bids.px.length && asks.px.length) {
      // Grouped levels are a whole step apart; the wire's spread is the real one.
      const abs = snap.spread ? Number(snap.spread) : asks.px[0] - bids.px[0];
      spread = fmt(abs, snap.spread ? Math.max(pxDecimals, fracDigits(snap.spread)) : pxDecimals);
      spreadPct = fmt((abs / ref) * 100, 3) + "%";
    }
  }
  return {
    asks: buildSlots(asks, false, max, pxDecimals, opts, prev.asks, change),
    bids: buildSlots(bids, true, max, pxDecimals, opts, prev.bids, change),
    spread,
    spreadPct,
    tick,
    groupings,
  };
}

/** Newest first, capped at the visible rows. `batch` is a wire message, oldest → newest. */
export function prependTrades(recent: readonly WireTrade[], batch: readonly WireTrade[]): WireTrade[] {
  return batch.slice().reverse().concat(recent).slice(0, TRADES);
}

/** Trades tab rows. Only the `fresh` leading slots (new since the last frame) get a new flash, so rows
 *  that merely shifted down do not re-animate. */
export function deriveTrades(
  recent: readonly WireTrade[],
  fresh: number,
  prev: readonly TradeSlot[],
  opts: Pick<DeriveOptions, "szDecimals" | "quote">,
): TradeSlot[] {
  let pxDecimals = 0;
  for (const t of recent) pxDecimals = Math.max(pxDecimals, fracDigits(t.px));
  const decimals = opts.quote ? 0 : opts.szDecimals;
  const slots = new Array<TradeSlot>(TRADES);
  for (let i = 0; i < TRADES; i++) {
    const t = recent[i];
    if (!t) {
      slots[i] = EMPTY_TRADE;
      continue;
    }
    const px = Number(t.px);
    const sz = Number(t.sz);
    const isFresh = i < fresh;
    slots[i] = {
      px: fmt(px, pxDecimals),
      sz: fmt(opts.quote ? sz * px : sz, decimals),
      time: timeFmt.format(t.time),
      side: t.side === "B" ? "buy" : "sell",
      flash: isFresh ? (t.side === "B" ? "up" : "down") : prev[i].flash,
      flashSeq: isFresh ? prev[i].flashSeq + 1 : prev[i].flashSeq,
    };
  }
  return slots;
}
