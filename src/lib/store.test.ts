import { beforeEach, expect, it, vi } from "vitest";
import { HISTORY, TRADES } from "./derive";
import type { WireL2Book, WireTrade } from "./types";

const feeds: Record<string, (d: WireL2Book) => void> = {};
vi.mock("./socket", () => ({
  start: () => {},
  onStatus: (listener: (s: string) => void) => listener("live"),
  subscribe: (sub: { type: string; fast?: boolean }, onData: (d: WireL2Book) => void) => {
    feeds[sub.type === "trades" ? "trades" : sub.fast ? "fast" : "deep"] = onData;
    return () => {};
  },
}));
const frames: FrameRequestCallback[] = [];
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
vi.stubGlobal("fetch", () => new Promise(() => {})); // short sides trigger an HTTP refill
const flush = () => frames.splice(0).forEach((cb) => cb(0));

let mod: typeof import("./store");
beforeEach(async () => {
  vi.resetModules();
  mod = await import("./store"); // fresh module state per test
  mod.boot();
});

const book = (bids: [string, string][], fast = false): WireL2Book => ({
  coin: "BTC",
  time: 0,
  levels: [bids.map(([px, sz]) => ({ px, sz, n: 1 })), [{ px: "101", sz: "1", n: 1 }]],
  ...(fast && { fast }),
});
/** `n` bid levels at 1 apart from `top` down, all of size `sz`. */
const ladder = (top: number, n: number, sz = "9"): [string, string][] => Array.from({ length: n }, (_, i) => [`${top - i}`, sz]);
const trade = (tid: number, px = "100"): WireTrade => ({ coin: "BTC", side: "B", px, sz: "1", time: 0, hash: "0x0", tid });
const bidSizes = () => mod.store.getState().book.bids.slice(0, 3).map((s) => s.sz);
const tradeCount = () => mod.store.getState().trades.length;
/** `n` fills from tid `from` up, oldest first like a wire batch. */
const fills = (from: number, n: number) => Array.from({ length: n }, (_, i) => trade(from + i));

it("keeps a level's last fast size when it leaves the fast window, until the next deep snapshot", () => {
  feeds.deep(book([["100", "9"], ["99", "9"], ["98", "9"]]));
  feeds.fast(book([["100", "1"], ["99", "1"]], true));
  flush();
  feeds.fast(book([["100", "1"]], true)); // 99 drops out of the fast window
  flush();
  expect(bidSizes()).toEqual(["1.00000", "1.00000", "9.00000"]);
  feeds.deep(book([["100", "5"], ["99", "5"], ["98", "5"]]));
  flush();
  expect(bidSizes()).toEqual(["1.00000", "5.00000", "5.00000"]);
});

it("clears the grouping labels on a coin switch, keeps them on a precision switch", () => {
  feeds.fast(book([["83000", "1"]], true));
  flush();
  const labels = () => mod.store.getState().book.groupings.map((g) => g.label);
  expect(labels()).toEqual(["1,000", "100", "10", "1"]);
  mod.setPrecision(2);
  expect([labels(), mod.store.getState().book.tick]).toEqual([["1,000", "100", "10", "1"], "1,000"]);
  mod.setCoin("ETH");
  expect(labels()).toEqual([]);
});

it("flashes a changed level, never the first frame, and clears flashes when the tab switches", () => {
  const flashes = () => mod.store.getState().book.bids.slice(0, 2).map((s) => s.flash);
  feeds.deep(book(ladder(100, 6)));
  feeds.fast(book(ladder(100, 2), true));
  flush();
  expect(flashes()).toEqual([0, 0]);
  feeds.fast(book([["100", "9"], ["99", "90"]], true));
  flush();
  expect(flashes()).toEqual([0, 1]);
  mod.setTab("trades");
  expect(flashes()).toEqual([0, 0]);
});

it("derives each fill once, on arrival, and the whole list only on a unit change", () => {
  feeds.trades([trade(1), trade(2)] as never);
  flush();
  const [second, first] = mod.store.getState().trades;
  feeds.trades([trade(3)] as never);
  flush();
  expect(mod.store.getState().trades.map((t) => [t.id, t.seq])).toEqual([[3, 2], [2, 1], [1, 0]]);
  expect(mod.store.getState().trades.slice(1)).toEqual([second, first]);
  expect(mod.store.getState().trades[1]).toBe(second); // the same object: its row doesn't re-render
  mod.setQuote(true);
  flush();
  expect(mod.store.getState().trades[1]).toMatchObject({ id: 2, seq: 1 });
  expect(mod.store.getState().trades[1]).not.toBe(second);
  expect(mod.store.getState().trades.map((t) => t.sz)).toEqual(["100", "100", "100"]);
});

it("keeps a scrolled trades view on the rows it shows as fills arrive, and commits a scroll with them", () => {
  const top = () => mod.store.getState().tradesTop;
  feeds.trades(fills(1, 30) as never);
  flush();
  feeds.trades([trade(31)] as never); // at the top: new fills show live
  flush();
  expect(top()).toBe(0);
  const setState = vi.spyOn(mod.store, "setState");
  mod.scrollTrades(1);
  feeds.trades([trade(32), trade(33)] as never); // the same frame as the scroll
  flush();
  expect(setState).toHaveBeenCalledTimes(1);
  expect(top()).toBe(3);
  mod.setQuote(true); // a unit change re-derives in place, and still moves with fills in its frame
  feeds.trades([trade(34)] as never);
  flush();
  expect(top()).toBe(4);
  feeds.trades([trade(34), trade(33)] as never); // a fill already listed is dropped, not listed twice
  flush();
  expect([top(), tradeCount()]).toEqual([4, 34]);
  feeds.trades(fills(35, 30) as never);
  mod.scrollTrades(1);
  flush();
  mod.setCoin("ETH");
  expect([top(), tradeCount()]).toEqual([0, 0]);
});

it("moves the trades view past fills landing above a focused row, so it stays in the DOM", () => {
  const top = () => mod.store.getState().tradesTop;
  feeds.trades(fills(1, 30) as never);
  flush();
  mod.holdTrades(true); // a row at the top has focus
  feeds.trades([trade(31), trade(32)] as never);
  flush();
  expect(top()).toBe(2);
  mod.holdTrades(false); // let go, the view is a scrolled one
  feeds.trades([trade(33)] as never);
  flush();
  expect(top()).toBe(3);
});

it("keeps a trades view at the end of a full history in range as its oldest fills drop out", () => {
  const top = () => mod.store.getState().tradesTop;
  feeds.trades(fills(1, HISTORY) as never);
  flush();
  mod.scrollTrades(HISTORY - TRADES); // the end: the browser scrolls no further
  flush();
  feeds.trades(fills(HISTORY + 1, 3) as never);
  flush();
  expect([top(), tradeCount()]).toEqual([HISTORY - TRADES, HISTORY]);
  mod.setTab("orders"); // hidden, the list has no scroll events to correct it
  for (let i = 0; i < 10; i++) {
    feeds.trades(fills(HISTORY + 4 + i * 5, 5) as never);
    flush();
  }
  expect(top()).toBe(HISTORY - TRADES);
});
