import { createStore } from "zustand/vanilla";
import { ASSETS, type Coin } from "./assets";
import { DEPTH, deriveBook, deriveTrades, EMPTY_BOOK, EMPTY_TRADES, HISTORY, mergeSnapshots, prependTrades, TRADES } from "./derive";
import { onStatus, start, subscribe, type Status } from "./socket";
import type { DisplayBook, NSigFigs, Slot, TradeSlot, WireL2Book, WireTrade } from "./types";

export type Tab = "orders" | "trades";

interface BookState {
  coin: Coin;
  nSigFigs: NSigFigs;
  /** Size and total in USD instead of the base asset. */
  quote: boolean;
  tab: Tab;
  status: Status;
  /** True between a subscription switch and its first snapshot. */
  loading: boolean;
  book: DisplayBook;
  trades: TradeSlot[];
  /** The trades list's first row in view. */
  tradesTop: number;
}

export const store = createStore<BookState>(() => ({
  coin: "BTC",
  nSigFigs: null,
  quote: false,
  tab: "orders",
  status: "connecting",
  loading: true,
  book: EMPTY_BOOK,
  trades: EMPTY_TRADES,
  tradesTop: 0,
}));

// Latest-wins buffers flushed by one rAF, so React renders at most once per frame.
let fast: WireL2Book | null = null;
let deep: WireL2Book | null = null;
/** Last merged book. Between deep snapshots each fast frame merges onto this, not onto `deep`, so a
 *  level leaving the fast window keeps its last fast size instead of reverting to an older deep one. */
let merged: WireL2Book | null = null;
/** The snapshot on screen, compared with the next one for flashes. */
let shown: WireL2Book | null = null;
let bookDirty = false;
let recent: WireTrade[] = [];
/** Fills received since the list started. */
let count = 0;
/** Fills at the head of `recent` not derived yet; `rederive` redoes the whole list. */
let fresh = 0;
let rederive = false;
/** The trades list's first row in view after its last scroll, until the next commit. */
let scrolled: number | null = null;
/** A trades row has focus: fills move the view as if scrolled, so it stays in the DOM. */
let held = false;
let raf = 0;
let stopBook: (() => void) | null = null;
let stopTrades: (() => void) | null = null;
/** Infinity while a refill is in flight, else when the last one ended. */
let refillAt = 0;

/** The deep ladder spans only ~$19 on BTC, so after a bigger move a side runs short until the next
 *  deep snapshot (~5s). Fetch a fresh 20-level book over HTTP instead: at most one in flight, ~1/s. */
function refill() {
  if (Date.now() - refillAt < 1000) return;
  refillAt = Infinity;
  const { coin, nSigFigs } = store.getState();
  fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin, ...(nSigFigs !== null && { nSigFigs }) }),
  })
    .then((res) => res.json())
    .then((book: WireL2Book) => {
      const s = store.getState();
      if (s.coin !== coin || s.nSigFigs !== nSigFigs || s.status !== "live") return;
      deep = book;
      merged = null;
      bookDirty = true;
      schedule();
    })
    .catch(() => {}) // the next deep snapshot fills the gap anyway
    .finally(() => (refillAt = Date.now()));
}

function commit() {
  const { coin, nSigFigs, quote, book, trades, tradesTop } = store.getState();
  const { szDecimals } = ASSETS[coin];
  const patch: Partial<BookState> = {};
  const snap = bookDirty ? (merged = mergeSnapshots(fast, merged ?? deep)) : null;
  if (snap) {
    if (snap.levels[0].length < DEPTH || snap.levels[1].length < DEPTH) refill();
    const live: [number, number] = [fast?.levels[0].length ?? 0, fast?.levels[1].length ?? 0];
    patch.book = deriveBook(snap, book, { szDecimals, nSigFigs, quote }, shown && { before: shown, live });
    patch.loading = false;
    shown = snap;
  }
  let top = scrolled ?? tradesTop;
  if (fresh || rederive) {
    const opts = { szDecimals, quote };
    const list = (patch.trades = rederive
      ? deriveTrades(recent, count - 1, opts)
      : deriveTrades(recent.slice(0, fresh), count - 1, opts).concat(trades).slice(0, HISTORY));
    // Scrolled down or holding focus, the view moves with prepended fills so the rows being read stay put.
    if (top || held) top = Math.min(top + fresh, Math.max(0, list.length - TRADES));
  }
  if (top !== tradesTop) patch.tradesTop = top;
  bookDirty = rederive = false;
  fresh = 0;
  scrolled = null;
  if (patch.book || patch.trades || patch.tradesTop !== undefined) store.setState(patch);
}

function flush() {
  raf = 0;
  commit();
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(flush);
}

/** Swap the book subscriptions to the current (coin, nSigFigs); what arrives next is a clean baseline. */
function resubscribeBook() {
  stopBook?.();
  fast = deep = merged = shown = null;
  bookDirty = false;
  const { coin, nSigFigs } = store.getState();
  const stopFast = subscribe({ type: "l2Book", coin, nSigFigs, fast: true }, (d) => {
    fast = d;
    bookDirty = true;
    schedule();
  });
  const stopDeep = subscribe({ type: "l2Book", coin, nSigFigs, fast: false }, (d) => {
    deep = d;
    merged = null;
    bookDirty = true;
    schedule();
  });
  stopBook = () => {
    stopFast();
    stopDeep();
  };
}

function resubscribeTrades() {
  stopTrades?.();
  recent = [];
  count = fresh = 0;
  rederive = false;
  scrolled = null;
  stopTrades = subscribe({ type: "trades", coin: store.getState().coin }, (batch) => {
    // tid keys the row, so never list a fill twice.
    const listed = new Set(recent.map((t) => t.tid));
    batch = batch.filter((t) => !listed.has(t.tid));
    recent = prependTrades(recent, batch);
    count += batch.length;
    fresh += batch.length;
    schedule();
  });
}

let booted = false;

export function boot() {
  if (booted) return;
  booted = true;
  onStatus((status) => {
    // Never merge snapshots from before and after a disconnect (the deep buffer could be minutes old
    // after sleep). The last book stays on screen, dimmed, until new data arrives.
    if (status !== "live") {
      fast = deep = merged = shown = null;
      recent = [];
      count = fresh = 0;
      rederive = true;
    }
    store.setState({ status });
  });
  resubscribeBook();
  resubscribeTrades();
  start();
}

/** The grouping menu stays empty until the new coin's first snapshot labels it. */
export function setCoin(coin: Coin) {
  if (coin === store.getState().coin) return;
  store.setState({ coin, loading: true, book: EMPTY_BOOK, trades: EMPTY_TRADES, tradesTop: 0 });
  resubscribeBook();
  resubscribeTrades();
}

export function setPrecision(nSigFigs: NSigFigs) {
  const { book, nSigFigs: current } = store.getState();
  if (nSigFigs === current) return;
  const tick = book.groupings.find((g) => g.value === nSigFigs)?.label ?? "";
  store.setState({ nSigFigs, loading: true, book: { ...EMPTY_BOOK, tick, groupings: book.groupings } });
  resubscribeBook();
}

/** Display-only change: re-derive the buffered data on the next frame. */
export function setQuote(quote: boolean) {
  if (quote === store.getState().quote) return;
  store.setState({ quote });
  bookDirty = rederive = true;
  schedule();
}

/** Applied in the next frame's commit, so scrolling while fills arrive still renders once per frame. */
export function scrollTrades(top: number) {
  scrolled = top;
  schedule();
}

export function holdTrades(on: boolean) {
  held = on;
}

const quiet = (slot: Slot) => (slot.flash ? { ...slot, flash: 0 } : slot);

/** Tab switches remount the rows, which would replay their last flash: clear them. */
export function setTab(tab: Tab) {
  const { tab: current, book } = store.getState();
  if (tab !== current) store.setState({ tab, book: { ...book, asks: book.asks.map(quiet), bids: book.bids.map(quiet) } });
}
