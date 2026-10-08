import { createStore } from "zustand/vanilla";
import { ASSETS, type Coin } from "./assets";
import { DEPTH, deriveBook, deriveTrades, EMPTY_BOOK, EMPTY_TRADES, fitsGrouping, HISTORY, mergeSnapshots, prependTrades, TRADES } from "./derive";
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
  /** From a subscription switch until its deep snapshot: missing rows are loading, not absent. */
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
/** Last merged book; fast frames merge onto it so a level leaving the fast window keeps its last fast size. */
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
/** Set on disconnect; the next message clears the stale buffers, so the last data stays on screen meanwhile. */
let resetBook = false;
let resetTrades = false;
/** Infinity while a refill is in flight, else when the last one ended. */
let refillAt = 0;
/** Bumped on resubscribe and disconnect; a refill started before one is dropped. */
let epoch = 0;

/** Levels a side in a deep or HTTP snapshot; a side with fewer has no more to fetch. */
const FULL = 20;
/** Refill below this many levels, so the reply usually lands before a row empties. */
const REFILL_BELOW = 16;

/** Top up a short side over HTTP: one fetch in flight, ~1/s, or back to back once a row is blank (`now`). */
function refill(now: boolean) {
  if (refillAt === Infinity || (!now && Date.now() - refillAt < 1000)) return;
  refillAt = Infinity;
  const { coin, nSigFigs } = store.getState();
  const at = epoch;
  fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin, ...(nSigFigs !== null && { nSigFigs }) }),
    signal: AbortSignal.timeout(2000),
  })
    .then((res) => res.json())
    .then((book: WireL2Book) => {
      // Overtaken by a switch, disconnect or newer deep snapshot, or not a book: drop it.
      if (at !== epoch || store.getState().status !== "live" || (deep && book.time <= deep.time)) return;
      if (!Array.isArray(book?.levels?.[0]) || !Array.isArray(book.levels[1])) return;
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
  const snap = bookDirty ? (merged = mergeSnapshots(fast, merged ?? deep, nSigFigs !== null)) : null;
  if (snap) {
    // Not before the first deep snapshot, nor on a side the deep one shows is exhausted.
    const left = (side: 0 | 1) => (deep && deep.levels[side].length >= FULL ? snap.levels[side].length : Infinity);
    const fewest = Math.min(left(0), left(1));
    if (fewest < REFILL_BELOW) refill(fewest < DEPTH);
    const live: [number, number] = [fast?.levels[0].length ?? 0, fast?.levels[1].length ?? 0];
    patch.book = deriveBook(snap, book, { szDecimals, nSigFigs, quote }, shown && { before: shown, live });
    patch.loading = !deep;
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

function resyncBook() {
  if (resetBook) fast = deep = merged = shown = null;
  resetBook = false;
}

/** Swap the book subscriptions to the current (coin, nSigFigs). */
function resubscribeBook() {
  stopBook?.();
  fast = deep = merged = shown = null;
  bookDirty = false;
  epoch++;
  const { coin, nSigFigs } = store.getState();
  // The ACK gate stops most old-grouping stragglers, but a few trail the ACK: drop those too.
  const fits = (d: WireL2Book) => fitsGrouping(d, nSigFigs, ASSETS[coin].szDecimals);
  const stopFast = subscribe({ type: "l2Book", coin, nSigFigs, fast: true }, (d) => {
    if (!fits(d)) return;
    // After a drop, wait for the deep snapshot rather than show a 5-level frame.
    const wait = resetBook;
    resyncBook();
    fast = d;
    if (wait) return;
    bookDirty = true;
    schedule();
  });
  const stopDeep = subscribe({ type: "l2Book", coin, nSigFigs, fast: false }, (d) => {
    if (!fits(d)) return;
    resyncBook();
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
    // After a drop, a new list replaces the stale one, from the top.
    if (resetTrades) {
      recent = [];
      count = 0;
      rederive = true;
      scrolled = 0;
      held = false;
    }
    // tid keys the row, so never list a fill twice.
    const listed = new Set(recent.map((t) => t.tid));
    batch = batch.filter((t) => !listed.has(t.tid));
    recent = prependTrades(recent, batch);
    resetTrades = false;
    count += batch.length;
    fresh += batch.length;
    schedule();
  });
}

let booted = false;

// Dev only: Fast Refresh can't carry the live socket into a re-run module, so reload the page instead.
import.meta.turbopackHot?.decline();

export function boot() {
  if (booted) return;
  booted = true;
  onStatus((status) => {
    // Never merge across a disconnect; the last book stays on screen, dimmed, until new data arrives.
    if (status !== "live") {
      resetBook = resetTrades = true;
      epoch++;
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

/** Display-only: re-derive the buffered data next frame. */
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
