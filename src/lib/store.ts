import { createStore } from "zustand/vanilla";
import { deriveBook, EMPTY_BOOK, mergeSnapshots, type Derived } from "./derive";
import { onStatus, start, subscribe, type Status } from "./socket";
import type { Coin, DisplayBook, NSigFigs, WireL2Book } from "./types";

const COINS: Record<Coin, { szDecimals: number }> = {
  BTC: { szDecimals: 5 },
  ETH: { szDecimals: 4 },
};

interface BookState {
  coin: Coin;
  nSigFigs: NSigFigs;
  /** Size and total in USD instead of the base asset. */
  quote: boolean;
  status: Status;
  /** True between a subscription switch and its first snapshot. */
  loading: boolean;
  book: DisplayBook;
}

export const store = createStore<BookState>(() => ({
  coin: "BTC",
  nSigFigs: null,
  quote: false,
  status: "connecting",
  loading: true,
  book: EMPTY_BOOK,
}));

// ---- Ingestion. One latest-wins slot per feed cadence; a single rAF flushes both at most once
// per frame, so React can never render more than once per frame regardless of message rate. ----
let fast: WireL2Book | null = null; // top 5 levels/side, ~2×/s
let deep: WireL2Book | null = null; // 20 levels/side, every ~5s
let raf = 0;
let derived: Derived | null = null;
let teardown: (() => void) | null = null;

function commit() {
  const snap = mergeSnapshots(fast, deep);
  if (!snap) return;
  const { coin, nSigFigs, quote } = store.getState();
  derived = deriveBook(snap, derived, { szDecimals: COINS[coin].szDecimals, nSigFigs, quote });
  store.setState({ book: derived.book, loading: false });
}

function flush() {
  raf = 0;
  commit();
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(flush);
}

/** Forget buffered snapshots and flash history; whatever arrives next renders as a clean baseline. */
function reset() {
  fast = deep = derived = null;
}

/** Swap both live subscriptions to the current (coin, nSigFigs) and forget everything from the old ones. */
function resubscribe() {
  teardown?.();
  reset();
  const { coin, nSigFigs } = store.getState();
  const stopFast = subscribe({ coin, nSigFigs, fast: true }, (d) => {
    fast = d;
    schedule();
  });
  const stopDeep = subscribe({ coin, nSigFigs, fast: false }, (d) => {
    deep = d;
    schedule();
  });
  teardown = () => {
    stopFast();
    stopDeep();
  };
}

let booted = false;

/** Boot the data layer. Idempotent, so React StrictMode's double effect is a no-op. */
export function boot() {
  if (booted) return;
  booted = true;
  onStatus((status) => {
    // Never merge a snapshot from before a disconnect with one from after it: after sleep the
    // deep buffer could be minutes old while the fast one is fresh. The last book stays on
    // screen (dimmed) until new data replaces it.
    if (status !== "live") reset();
    store.setState({ status });
  });
  resubscribe();
  start();
}

export function setCoin(coin: Coin) {
  if (coin === store.getState().coin) return;
  store.setState({ coin, loading: true, book: EMPTY_BOOK });
  resubscribe();
}

export function setPrecision(nSigFigs: NSigFigs) {
  if (nSigFigs === store.getState().nSigFigs) return;
  store.setState({ nSigFigs, loading: true, book: EMPTY_BOOK });
  resubscribe();
}

/** Display-only change: re-derive the buffered snapshots on the next frame instead of waiting for data. */
export function setQuote(quote: boolean) {
  if (quote === store.getState().quote) return;
  store.setState({ quote });
  schedule();
}
