import type { DisplayBook, Flash, Slot, WireL2Book, WireLevel } from "./types";

/** Rows per side. Fixed so the DOM never changes shape. */
export const DEPTH = 11;

export interface DeriveOptions {
  szDecimals: number;
  /** Show size/total in quote currency (USD) instead of base. */
  quote: boolean;
}

/** Previous frame's parsed sizes keyed by wire price string, for change detection. */
type Sizes = ReadonlyMap<string, number>;

export interface Derived {
  book: DisplayBook;
  sizes: [bids: Sizes, asks: Sizes];
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

interface Side {
  /** Wire price strings of the displayed levels — canonical within one grouping, used as change-detection keys. */
  keys: string[];
  px: number[];
  sz: number[];
  cum: number[];
  sizes: Map<string, number>;
  pxDecimals: number;
  /** Smallest gap between adjacent displayed levels, or Infinity. */
  minGap: number;
}

function parseSide(levels: WireLevel[]): Side {
  const n = Math.min(levels.length, DEPTH);
  const keys = new Array<string>(n);
  const px = new Array<number>(n);
  const sz = new Array<number>(n);
  const cum = new Array<number>(n);
  const sizes = new Map<string, number>();
  let acc = 0;
  let pxDecimals = 0;
  let minGap = Infinity;
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
    cum[i] = acc;
    pxDecimals = Math.max(pxDecimals, fracDigits(level.px));
    if (i > 0) minGap = Math.min(minGap, Math.abs(px[i] - px[i - 1]));
  }
  return { keys, px, sz, cum, sizes, pxDecimals, minGap };
}

function buildSlots(
  side: Side,
  prevSizes: Sizes | null,
  prevSlots: readonly Slot[] | null,
  max: number,
  pxDecimals: number,
  opts: DeriveOptions,
): Slot[] {
  const slots = new Array<Slot>(DEPTH);
  const decimals = opts.quote ? 0 : opts.szDecimals;
  for (let i = 0; i < DEPTH; i++) {
    if (i >= side.px.length) {
      slots[i] = EMPTY_SLOT;
      continue;
    }
    const size = side.sz[i];
    // Flash state belongs to the slot and persists until the next change there, so a finished
    // animation is never re-triggered by unrelated frames or by rows shifting position.
    const prev = prevSlots ? prevSlots[i] : EMPTY_SLOT;
    let flash = prev.flash;
    let flashSeq = prev.flashSeq;
    if (prevSizes) {
      const before = prevSizes.get(side.keys[i]);
      const dir: Flash = before === undefined || size > before ? "up" : size < before ? "down" : "";
      if (dir) {
        flash = dir;
        flashSeq = prev.flashSeq + 1;
      }
    }
    const mult = opts.quote ? side.px[i] : 1;
    slots[i] = {
      px: fmt(side.px[i], pxDecimals),
      sz: fmt(size * mult, decimals),
      total: fmt(side.cum[i] * mult, decimals),
      ratio: side.cum[i] / max,
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
  const bids = parseSide(snap.levels[0]);
  const asks = parseSide(snap.levels[1]);
  const bidDepth = bids.cum[bids.cum.length - 1] ?? 0;
  const askDepth = asks.cum[asks.cum.length - 1] ?? 0;
  const max = Math.max(bidDepth, askDepth) || 1;
  const pxDecimals = Math.max(bids.pxDecimals, asks.pxDecimals);

  let spread = "";
  let spreadPct = "";
  if (bids.px.length && asks.px.length) {
    const abs = asks.px[0] - bids.px[0];
    spread = fmt(abs, pxDecimals);
    spreadPct = fmt((abs / ((asks.px[0] + bids.px[0]) / 2)) * 100, 3) + "%";
  }
  const gap = Math.min(bids.minGap, asks.minGap);
  const total = bidDepth + askDepth;
  const bidShare = total ? bidDepth / total : 0.5;

  return {
    book: {
      asks: buildSlots(asks, prev?.sizes[1] ?? null, prev?.book.asks ?? null, max, pxDecimals, opts),
      bids: buildSlots(bids, prev?.sizes[0] ?? null, prev?.book.bids ?? null, max, pxDecimals, opts),
      spread,
      spreadPct,
      tick: Number.isFinite(gap) ? fmt(gap, pxDecimals) : "",
      bidShare,
      bidPct: fmt(bidShare * 100, 0) + "%",
      askPct: fmt((1 - bidShare) * 100, 0) + "%",
    },
    sizes: [bids.sizes, asks.sizes],
  };
}
