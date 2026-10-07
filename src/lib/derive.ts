import type { DisplayBook, Flash, NSigFigs, Slot, WireL2Book, WireLevel } from "./types";

/** Rows per side. Fixed so the DOM never changes shape. */
export const DEPTH = 11;

export interface DeriveOptions {
  szDecimals: number;
  nSigFigs: NSigFigs;
  /** Show size/total/depth in quote currency (USD) instead of base. */
  quote: boolean;
}

/** Previous frame's parsed sizes keyed by wire price string, for change detection. */
type Sizes = ReadonlyMap<string, number>;

export interface Derived {
  book: DisplayBook;
  sizes: [bids: Sizes, asks: Sizes];
  /** Deepest price known per side last frame (±Infinity when that side was empty); levels beyond it are learned, not new. */
  edges: [bid: number, ask: number];
}

const EMPTY_SLOT: Slot = { px: "", sz: "", total: "", ratio: 0, flash: "", flashSeq: 0 };

export const EMPTY_BOOK: DisplayBook = {
  asks: Array<Slot>(DEPTH).fill(EMPTY_SLOT),
  bids: Array<Slot>(DEPTH).fill(EMPTY_SLOT),
  spread: "",
  spreadPct: "",
  tick: "",
  bidShare: 0.5,
  bidPct: "",
  askPct: "",
};

const formatters = new Map<number, Intl.NumberFormat>();

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

/**
 * Price step of the current grouping. Hyperliquid perp prices carry at most 5 significant
 * figures and at most (6 - szDecimals) decimals, integers always allowed; `nSigFigs` groups to
 * that many figures of the current magnitude. Deterministic, unlike the gap between levels,
 * which widens whenever the top of a book thins out.
 */
function tickOf(price: number, nSigFigs: NSigFigs, szDecimals: number): number {
  const digits = Math.floor(Math.log10(price)) + 1;
  if (nSigFigs !== null) return 10 ** (digits - nSigFigs);
  return Math.max(Math.min(10 ** (digits - 5), 1), 10 ** (szDecimals - 6));
}

interface Side {
  bids: boolean;
  /** Wire price strings of the displayed levels — canonical within one grouping, used as change-detection keys. */
  keys: string[];
  px: number[];
  sz: number[];
  /** Cumulative size in base units, and in quote units (Σ size × price). */
  cum: number[];
  cumQuote: number[];
  sizes: Map<string, number>;
  edge: number;
  pxDecimals: number;
}

function parseSide(levels: WireLevel[], bids: boolean): Side {
  const n = Math.min(levels.length, DEPTH);
  const keys = new Array<string>(n);
  const px = new Array<number>(n);
  const sz = new Array<number>(n);
  const cum = new Array<number>(n);
  const cumQuote = new Array<number>(n);
  const sizes = new Map<string, number>();
  let acc = 0;
  let accQuote = 0;
  let pxDecimals = 0;
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const size = Number(level.sz);
    // Remember sizes beyond the displayed depth too, so a level scrolling into view is not mistaken for a new one.
    sizes.set(level.px, size);
    if (i >= n) continue;
    keys[i] = level.px;
    px[i] = Number(level.px);
    sz[i] = size;
    acc += size;
    accQuote += size * px[i];
    cum[i] = acc;
    cumQuote[i] = accQuote;
    pxDecimals = Math.max(pxDecimals, fracDigits(level.px));
  }
  // An empty side knows no prices, so nothing can be "inside" its range next frame.
  const edge = levels.length ? Number(levels[levels.length - 1].px) : bids ? Infinity : -Infinity;
  return { bids, keys, px, sz, cum, cumQuote, sizes, edge, pxDecimals };
}

function buildSlots(side: Side, prev: Derived | null, max: number, pxDecimals: number, opts: DeriveOptions): Slot[] {
  const i0 = side.bids ? 0 : 1;
  const prevSlots = prev ? (side.bids ? prev.book.bids : prev.book.asks) : null;
  const cum = opts.quote ? side.cumQuote : side.cum;
  const decimals = opts.quote ? 0 : opts.szDecimals;
  const slots = new Array<Slot>(DEPTH);
  for (let i = 0; i < DEPTH; i++) {
    if (i >= side.px.length) {
      slots[i] = EMPTY_SLOT;
      continue;
    }
    const size = side.sz[i];
    // Flash state belongs to the slot and persists until the next change there, so a finished
    // animation is never re-triggered by unrelated frames or by rows shifting position.
    const prevSlot = prevSlots ? prevSlots[i] : EMPTY_SLOT;
    let flash = prevSlot.flash;
    let flashSeq = prevSlot.flashSeq;
    if (prev) {
      const before = prev.sizes[i0].get(side.keys[i]);
      let dir: Flash = "";
      if (before === undefined) {
        // Unknown price inside the range we already knew = a new level. Beyond it = depth we
        // only just learned about (e.g. the deep snapshot landing after the fast one), not news.
        const inside = side.bids ? side.px[i] > prev.edges[i0] : side.px[i] < prev.edges[i0];
        if (inside) dir = "up";
      } else if (size !== before) {
        dir = size > before ? "up" : "down";
      }
      if (dir) {
        flash = dir;
        flashSeq = prevSlot.flashSeq + 1;
      }
    }
    slots[i] = {
      px: fmt(side.px[i], pxDecimals),
      sz: fmt(opts.quote ? size * side.px[i] : size, decimals),
      total: fmt(cum[i], decimals),
      ratio: cum[i] / max,
      flash,
      flashSeq,
    };
  }
  return slots;
}

/**
 * Combine the two feed cadences into one snapshot: the fast top-of-book levels verbatim, then
 * the deep snapshot's levels strictly beyond the last fast price on each side. Deep levels that
 * overlap the fast range are dropped because they are up to ~5s older than the fast ones.
 */
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
  };
}

/**
 * The whole per-frame derivation in one pass: parse, cumulative sums, a max shared by both
 * sides (so bid and ask depth are visually comparable), change detection against the previous
 * frame, and display formatting. Pass `prev = null` after a symbol/precision switch so the
 * first snapshot renders as a clean baseline with no flashes.
 */
export function deriveBook(snap: WireL2Book, prev: Derived | null, opts: DeriveOptions): Derived {
  const bids = parseSide(snap.levels[0], true);
  const asks = parseSide(snap.levels[1], false);
  const depthOf = (s: Side) => (opts.quote ? s.cumQuote : s.cum)[s.cum.length - 1] ?? 0;
  const bidDepth = depthOf(bids);
  const askDepth = depthOf(asks);
  const max = Math.max(bidDepth, askDepth) || 1;
  const pxDecimals = Math.max(bids.pxDecimals, asks.pxDecimals);

  let spread = "";
  let spreadPct = "";
  let tick = "";
  const ref = bids.px.length && asks.px.length ? (bids.px[0] + asks.px[0]) / 2 : (bids.px[0] ?? asks.px[0]);
  if (ref !== undefined) {
    const step = tickOf(ref, opts.nSigFigs, opts.szDecimals);
    tick = fmt(step, Math.max(pxDecimals, -Math.round(Math.log10(step))));
    if (bids.px.length && asks.px.length) {
      const abs = asks.px[0] - bids.px[0];
      spread = fmt(abs, pxDecimals);
      spreadPct = fmt((abs / ref) * 100, 3) + "%";
    }
  }
  const total = bidDepth + askDepth;
  const bidShare = total ? bidDepth / total : 0.5;

  return {
    book: {
      asks: buildSlots(asks, prev, max, pxDecimals, opts),
      bids: buildSlots(bids, prev, max, pxDecimals, opts),
      spread,
      spreadPct,
      tick,
      bidShare,
      bidPct: fmt(bidShare * 100, 0) + "%",
      askPct: fmt((1 - bidShare) * 100, 0) + "%",
    },
    sizes: [bids.sizes, asks.sizes],
    edges: [bids.edge, asks.edge],
  };
}
