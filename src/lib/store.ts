import { createStore } from "zustand/vanilla";
import { DEPTH, deriveBook, deriveTrades, EMPTY_BOOK, EMPTY_TRADES, mergeSnapshots, prependTrades, type Derived } from "./derive";
import { onStatus, start, subscribe, type Status } from "./socket";
import type { Coin, DisplayBook, Flash, NSigFigs, TradeSlot, WireL2Book, WireTrade } from "./types";

/** Per-market constants from the `meta` endpoint (size decimals and max leverage). */
export const MARKETS: Record<Coin, { szDecimals: number; maxLeverage: number }> = {
  BTC: { szDecimals: 5, maxLeverage: 40 },
  ETH: { szDecimals: 4, maxLeverage: 25 },
};

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
}));

// Latest-wins slots per book cadence plus a capped trade list, flushed by one rAF:
// React never renders more than once per frame.
let fast: WireL2Book | null = null;
let deep: WireL2Book | null = null;
/** Last merged book. Between deep snapshots each fast frame merges onto this, not onto `deep`, so a
 *  level leaving the fast window keeps its last fast size instead of reverting to an older deep one. */
let merged: WireL2Book | null = null;
let bookDirty = false;
let derived: Derived | null = null;
let recent: WireTrade[] = [];
let fresh = 0;
let tradesDirty = false;
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
  const { coin, nSigFigs, quote, trades } = store.getState();
  const { szDecimals } = MARKETS[coin];
  const patch: Partial<BookState> = {};
  const snap = bookDirty ? (merged = mergeSnapshots(fast, merged ?? deep)) : null;
  if (snap) {
    if (snap.levels[0].length < DEPTH || snap.levels[1].length < DEPTH) refill();
    const fastLen: [number, number] | undefined = fast ? [fast.levels[0].length, fast.levels[1].length] : undefined;
    derived = deriveBook(snap, derived, { szDecimals, nSigFigs, quote }, fastLen);
    patch.book = derived.book;
    patch.loading = false;
  }
  if (tradesDirty) {
    patch.trades = deriveTrades(recent, fresh, trades, { szDecimals, quote });
    fresh = 0;
  }
  bookDirty = tradesDirty = false;
  if (patch.book || patch.trades) store.setState(patch);
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
  fast = deep = merged = derived = null;
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
  fresh = 0;
  tradesDirty = false;
  stopTrades = subscribe({ type: "trades", coin: store.getState().coin }, (batch) => {
    // The first batch after (re)subscribing is history, not news: render it without flashes.
    if (recent.length) fresh += batch.length;
    recent = prependTrades(recent, batch);
    tradesDirty = true;
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
      fast = deep = merged = derived = null;
      recent = [];
      fresh = 0;
    }
    store.setState({ status });
  });
  resubscribeBook();
  resubscribeTrades();
  start();
}

/** Clear the book for a switch but keep the precision menu populated until the first snapshot relabels it.
 *  A precision switch already knows its step, so only cold start and coin switches show "—". */
function clearBook(tick = ""): DisplayBook {
  return { ...EMPTY_BOOK, tick, groupings: store.getState().book.groupings };
}

export function setCoin(coin: Coin) {
  if (coin === store.getState().coin) return;
  store.setState({ coin, loading: true, book: clearBook(), trades: EMPTY_TRADES });
  resubscribeBook();
  resubscribeTrades();
}

export function setPrecision(nSigFigs: NSigFigs) {
  if (nSigFigs === store.getState().nSigFigs) return;
  const tick = store.getState().book.groupings.find((g) => g.value === nSigFigs)?.step ?? "";
  store.setState({ nSigFigs, loading: true, book: clearBook(tick) });
  resubscribeBook();
}

/** Display-only change: re-derive the buffered data on the next frame. */
export function setQuote(quote: boolean) {
  if (quote === store.getState().quote) return;
  store.setState({ quote });
  bookDirty = tradesDirty = true;
  schedule();
}

const quiet = <T extends { flash: Flash; flashSeq: number }>(s: T): T => (s.flashSeq ? { ...s, flash: "", flashSeq: 0 } : s);

/** Switching tabs remounts the panel's rows, which would replay every slot's last flash: clear them. */
export function setTab(tab: Tab) {
  const { tab: current, book, trades } = store.getState();
  if (tab === current) return;
  const quietBook = { ...book, asks: book.asks.map(quiet), bids: book.bids.map(quiet) };
  if (derived) derived = { ...derived, book: quietBook };
  store.setState({ tab, book: quietBook, trades: trades.map(quiet) });
}
