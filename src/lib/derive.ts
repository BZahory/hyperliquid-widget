import type { DisplayBook, Grouping, NSigFigs, Slot, TradeSlot, WireL2Book, WireLevel, WireTrade } from "./types";

/** Rows per side, fixed so the DOM never changes shape. */
export const DEPTH = 12;
/** Trade rows in view: both book sides plus the spread row. */
export const TRADES = DEPTH * 2 + 1;
/** Fills kept for the trades tab: ~2 min of busy BTC. Each is formatted once, on arrival. */
export const HISTORY = 500;
/** A level flashes when its size changes by ≥ FLASH_PCT% and by ≥ FLASH_AVGS average levels of its side;
 *  the size floor keeps dust orders (a 100% change) from flashing every frame (see README). */
const FLASH_PCT = 50n;
const FLASH_AVGS = 2n;

export interface DeriveOptions {
  szDecimals: number;
  nSigFigs: NSigFigs;
  /** Sizes and totals in USD instead of the base asset. */
  quote: boolean;
}

const EMPTY_SLOT: Slot = { px: "", sz: "", total: "", ratio: 0, pxFull: "", szFull: "", totalFull: "", avg: "", flash: 0 };

export const EMPTY_BOOK: DisplayBook = {
  asks: Array<Slot>(DEPTH).fill(EMPTY_SLOT),
  bids: Array<Slot>(DEPTH).fill(EMPTY_SLOT),
  spread: "",
  spreadPct: "",
  spreadFull: "",
  spreadPctFull: "",
  bidShare: 0.5,
  tick: "",
  groupings: [],
};

export const EMPTY_TRADES: TradeSlot[] = [];

/** Fixed-point scale for wire decimals (≤ 6 on the wire), so sums are exact; notionals are at 2 × SCALE. */
const SCALE = 8;
const ONE = 10n ** BigInt(SCALE);

/** "83452.5" → 8345250000000n. */
function toInt(s: string): bigint {
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole + frac.padEnd(SCALE, "0").slice(0, SCALE));
}

/** Fixed-point → decimal string, which Intl formats exactly. */
function toDec(n: bigint, scale = SCALE): `${number}` {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(scale + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, -scale)}.${s.slice(-scale)}` as `${number}`;
}

/** a / b at SCALE, rounded half up; a and b at the same scale, both ≥ 0. */
const ratioOf = (a: bigint, b: bigint) => (a * ONE + b / 2n) / b;

const formatters = new Map<string, Intl.NumberFormat>();
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Fixed decimals so cells keep their width; `trim` drops trailing zeros. */
function fmt(v: number | `${number}`, decimals: number, trim = false): string {
  const key = `${decimals}${trim ? "t" : ""}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: trim ? 0 : decimals, maximumFractionDigits: decimals });
    formatters.set(key, f);
  }
  return f.format(v);
}

/** Every significant digit, for the hover reveal. */
const exact = (v: `${number}`) => fmt(v, 20, true);

/** Whole dollars; a non-zero notional under $0.50 reads "<1", not "0". */
const usd = (n: bigint) => (n > 0n && 2n * n < ONE * ONE ? "<1" : fmt(toDec(n, 2 * SCALE), 0));

/** Grouping step as a power of ten, from Hyperliquid's tick rules (≤5 sig figs, ≤ 6 − szDecimals decimals). */
function stepExp(price: number, nSigFigs: NSigFigs, szDecimals: number): number {
  const digits = Math.floor(Math.log10(price)) + 1;
  if (nSigFigs !== null) return digits - nSigFigs;
  return Math.max(Math.min(digits - 5, 0), szDecimals - 6);
}

const fmtStep = (exp: number) => fmt(10 ** exp, Math.max(0, -exp));

/** Price decimals from the step, not the visible prices, so the column keeps its width. */
const decimalsFrom = (low: number, nSigFigs: NSigFigs, szDecimals: number) => Math.max(0, -stepExp(low, nSigFigs, szDecimals));

/** Grouping options by step, coarse → fine, each step once; reuses `prev` when unchanged to avoid renders. */
function groupingsAt(price: number, szDecimals: number, prev: Grouping[]): Grouping[] {
  const full = stepExp(price, null, szDecimals);
  const next: Grouping[] = [];
  for (const n of [2, 3, 4, 5] as const) {
    const exp = stepExp(price, n, szDecimals);
    if (exp > full) next.push({ value: n, label: fmtStep(exp) });
  }
  next.push({ value: null, label: fmtStep(full) });
  const same = prev.length === next.length && next.every((g, i) => g.label === prev[i].label);
  return same ? prev : next;
}

interface Side {
  levels: WireLevel[];
  px: bigint[];
  sz: bigint[];
  /** Cumulative size and notional from the touch. */
  cum: bigint[];
  cumQuote: bigint[];
}

function parseSide(wire: WireLevel[]): Side {
  const levels = wire.slice(0, DEPTH);
  const px = levels.map((l) => toInt(l.px));
  const sz = levels.map((l) => toInt(l.sz));
  const cum: bigint[] = [];
  const cumQuote: bigint[] = [];
  let acc = 0n;
  let accQuote = 0n;
  for (let i = 0; i < levels.length; i++) {
    acc += sz[i];
    accQuote += sz[i] * px[i];
    cum.push(acc);
    cumQuote.push(accQuote);
  }
  return { levels, px, sz, cum, cumQuote };
}

/** What a frame is compared with to find changed levels. */
export interface Change {
  /** The previous full snapshot, so a level scrolling into view isn't new. */
  before: WireL2Book;
  /** Fast-feed levels per side [bids, asks]; only these flash (deeper rows change in ~5 s batches). */
  live: [number, number];
}

function buildSlots(side: Side, bids: boolean, max: bigint, pxDecimals: number, opts: DeriveOptions, prev: Slot[], change: Change | null): Slot[] {
  const show = (n: bigint) => (opts.quote ? usd(n) : fmt(toDec(n), opts.szDecimals));
  const scale = opts.quote ? 2 * SCALE : SCALE;
  // Grouped notionals use bucket prices: approximate.
  const approx = opts.quote && opts.nSigFigs !== null ? "≈" : "";
  const before = change?.before.levels[bids ? 0 : 1] ?? [];
  const sizes = new Map(before.map((l) => [toInt(l.px), toInt(l.sz)]));
  const edge = before.length ? toInt(before[before.length - 1].px) : undefined;
  const live = change?.live[bids ? 0 : 1] ?? 0;
  const floor = FLASH_AVGS * (side.cum[side.cum.length - 1] ?? 0n);
  const slots = new Array<Slot>(DEPTH);
  for (let i = 0; i < DEPTH; i++) {
    if (i >= side.px.length) {
      slots[i] = EMPTY_SLOT;
      continue;
    }
    const sz = opts.quote ? side.sz[i] * side.px[i] : side.sz[i];
    const total = opts.quote ? side.cumQuote[i] : side.cum[i];
    // Average fill of a market order sweeping to here (approximate when grouped).
    const avg = toDec(side.cum[i] ? (side.cumQuote[i] + side.cum[i] / 2n) / side.cum[i] : side.px[i]);
    // An unknown price is new inside last frame's range, but beyond it is only newly learned depth.
    let flash = prev[i].flash;
    if (i < live) {
      const inside = edge !== undefined && (bids ? side.px[i] > edge : side.px[i] < edge);
      const was = sizes.get(side.px[i]) ?? (inside ? 0n : side.sz[i]);
      const now = side.sz[i];
      const delta = now > was ? now - was : was - now;
      if (delta * 100n >= FLASH_PCT * (now > was ? now : was) && delta * BigInt(side.sz.length) >= floor) flash++;
    }
    slots[i] = {
      px: fmt(side.levels[i].px as `${number}`, pxDecimals),
      sz: show(sz),
      total: show(total),
      ratio: Number(total) / Number(max),
      pxFull: exact(side.levels[i].px as `${number}`),
      szFull: approx + exact(toDec(sz, scale)),
      totalFull: approx + exact(toDec(total, scale)),
      avg: opts.nSigFigs === null ? fmt(avg, pxDecimals + 2, true) : `≈${fmt(avg, pxDecimals)}`,
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
  const depthOf = (s: Side) => (opts.quote ? s.cumQuote : s.cum)[s.cum.length - 1] ?? 0n;
  const bidDepth = depthOf(bids);
  const askDepth = depthOf(asks);
  const max = (bidDepth > askDepth ? bidDepth : askDepth) || 1n;
  const bidShare = bidDepth + askDepth ? Number(bidDepth) / Number(bidDepth + askDepth) : 0.5;
  const low = bids.px[bids.px.length - 1] ?? asks.px[0];
  const pxDecimals = low !== undefined ? decimalsFrom(Number(toDec(low)), opts.nSigFigs, opts.szDecimals) : 0;
  const both = bids.px.length > 0 && asks.px.length > 0;
  const mid = both ? (bids.px[0] + asks.px[0]) / 2n : null;

  const book: DisplayBook = {
    asks: buildSlots(asks, false, max, pxDecimals, opts, prev.asks, change),
    bids: buildSlots(bids, true, max, pxDecimals, opts, prev.bids, change),
    spread: "",
    spreadPct: "",
    spreadFull: "",
    spreadPctFull: "",
    bidShare,
    tick: "",
    groupings: prev.groupings,
  };
  const ref = mid ?? bids.px[0] ?? asks.px[0];
  if (ref !== undefined) {
    const price = Number(toDec(ref));
    book.tick = fmtStep(stepExp(price, opts.nSigFigs, opts.szDecimals));
    book.groupings = groupingsAt(price, opts.szDecimals, prev.groupings);
  }
  if (mid) {
    // Grouped levels are a step apart; the wire's spread is the real one.
    const spread = snap.spread ? toInt(snap.spread) : asks.px[0] - bids.px[0];
    const pct = toDec(ratioOf(spread * 100n, mid));
    book.spread = fmt(toDec(spread), decimalsFrom(Number(toDec(bids.px[0])), null, opts.szDecimals));
    book.spreadPct = `${fmt(pct, 3)}%`;
    book.spreadFull = exact(toDec(spread));
    // Grouped, the mid is a bucket mid: approximate.
    book.spreadPctFull = `${opts.nSigFigs === null ? "" : "≈"}${exact(pct)}%`;
  }
  return book;
}

/** Newest first, capped at HISTORY; `batch` arrives oldest → newest. */
export function prependTrades(recent: readonly WireTrade[], batch: readonly WireTrade[]): WireTrade[] {
  return batch.slice().reverse().concat(recent).slice(0, HISTORY);
}

/** A real tx hash; TWAP and liquidation fills carry an all-zero one the explorer can't show. */
const TX = /^0x(?!0+$)[0-9a-f]{64}$/i;

/** Trades tab rows, newest first; `fills[0]` gets seq `seq`. */
export function deriveTrades(fills: readonly WireTrade[], seq: number, opts: Pick<DeriveOptions, "szDecimals" | "quote">): TradeSlot[] {
  return fills.map((t, i) => {
    const value = toInt(t.sz) * toInt(t.px);
    return {
      id: t.tid,
      seq: seq - i,
      px: fmt(t.px as `${number}`, decimalsFrom(Number(t.px), null, opts.szDecimals)),
      sz: opts.quote ? usd(value) : fmt(t.sz as `${number}`, opts.szDecimals),
      time: timeFmt.format(t.time),
      side: t.side === "B" ? "buy" : "sell",
      pxFull: exact(t.px as `${number}`),
      szFull: exact(opts.quote ? toDec(value, 2 * SCALE) : (t.sz as `${number}`)),
      href: TX.test(t.hash) ? `https://app.hyperliquid.xyz/explorer/tx/${t.hash}` : "",
    };
  });
}
