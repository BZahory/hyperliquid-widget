import { beforeEach, expect, it, vi } from "vitest";
import { HISTORY, TRADES } from "./derive";
import type { WireL2Book, WireTrade } from "./types";

const feeds: Record<string, (d: never) => void> = {};
let emitStatus: (s: string) => void = () => {};
vi.mock("./socket", () => ({
  start: () => {},
  onStatus: (listener: (s: string) => void) => {
    emitStatus = listener;
    listener("live");
  },
  subscribe: (sub: { type: string; fast?: boolean }, onData: (d: never) => void) => {
    feeds[sub.type === "trades" ? "trades" : sub.fast ? "fast" : "deep"] = onData;
    return () => {};
  },
}));
const frames: FrameRequestCallback[] = [];
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
/** Short sides trigger an HTTP refill; each test settles it via `reply`. */
let reply: (body: unknown) => void = () => {};
const fetchMock = vi.fn(() => new Promise((resolve) => (reply = (body) => resolve({ json: () => body }))));
vi.stubGlobal("fetch", fetchMock);
const flush = () => frames.splice(0).forEach((cb) => cb(0));

let mod: typeof import("./store");
beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockClear();
  mod = await import("./store"); // fresh module state per test
  mod.boot();
});

const book = (bids: [string, string][], fast = false, time = 0): WireL2Book => ({
  coin: "BTC",
  time,
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
  feeds.deep(book([["100", "9"], ["99", "9"], ["98", "9"]]) as never);
  feeds.fast(book([["100", "1"], ["99", "1"]], true) as never);
  flush();
  feeds.fast(book([["100", "1"]], true) as never); // 99 drops out of the fast window
  flush();
  expect(bidSizes()).toEqual(["1.00000", "1.00000", "9.00000"]);
  feeds.deep(book([["100", "5"], ["99", "5"], ["98", "5"]]) as never);
  flush();
  expect(bidSizes()).toEqual(["1.00000", "5.00000", "5.00000"]);
});

it("keeps the last data through a disconnect, re-derivable in the other unit, and starts clean after it", () => {
  feeds.deep(book([["100", "9"], ["99", "9"], ["98", "9"]]) as never);
  feeds.trades([trade(1), trade(2)] as never);
  flush();
  feeds.trades([trade(3)] as never); // lands in the same frame as the disconnect
  emitStatus("offline");
  flush();
  expect(tradeCount()).toBe(3);
  mod.setQuote(true);
  flush();
  expect(bidSizes()).toEqual(["900", "891", "882"]);
  expect(tradeCount()).toBe(3);
  emitStatus("live");
  feeds.fast(book([["100", "1"]], true) as never); // nothing from before the drop merges with it
  feeds.deep(book([["100", "2"], ["99", "2"]]) as never);
  feeds.trades([trade(4)] as never);
  flush();
  expect(bidSizes()).toEqual(["100", "198", ""]);
  expect(tradeCount()).toBe(1);
});

it("after a reconnect, keeps the last book up until the deep snapshot lands rather than show the fast top alone", () => {
  feeds.deep(book(ladder(100, 3)) as never);
  flush();
  emitStatus("reconnecting");
  emitStatus("live");
  feeds.fast(book([["100", "1"]], true) as never);
  flush();
  expect(bidSizes()).toEqual(["9.00000", "9.00000", "9.00000"]);
  feeds.deep(book(ladder(100, 3, "2")) as never);
  flush();
  expect(bidSizes()).toEqual(["1.00000", "2.00000", "2.00000"]);
  // Without a deep snapshot, the next fast one shows anyway.
  emitStatus("reconnecting");
  emitStatus("live");
  feeds.fast(book([["100", "3"]], true) as never);
  feeds.fast(book([["100", "4"]], true) as never);
  flush();
  expect(bidSizes()).toEqual(["4.00000", "", ""]);
});

it("refills before a side runs out, at once if a row is blank, unless the deep snapshot shows it has no more, and drops a stale reply", async () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  vi.useFakeTimers({ toFake: ["Date"] });
  feeds.fast(book([["100", "1"]], true) as never);
  flush();
  expect(fetchMock).not.toHaveBeenCalled(); // the deep snapshot is milliseconds away
  expect(mod.store.getState().loading).toBe(true); // so the rows past the fast top are loading
  feeds.deep(book(ladder(100, 20), false, 10) as never);
  flush();
  expect(fetchMock).not.toHaveBeenCalled(); // 20 levels
  feeds.fast(book([["96", "1"]], true) as never); // 96 + 15 deeper ones left
  flush();
  expect(fetchMock).not.toHaveBeenCalled();
  feeds.fast(book([["95", "1"]], true) as never); // down to 15: refill
  flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  reply(book(ladder(95, 20, "7"), false, 5)); // older than the deep snapshot it would replace
  await settle();
  flush();
  expect(mod.store.getState().book.bids[1].sz).toBe("9.00000");
  vi.setSystemTime(Date.now() + 1_100); // past the 1/s throttle
  feeds.fast(book([["95", "1"]], true) as never);
  flush();
  reply(book(ladder(95, 20, "7"), false, 20));
  await settle();
  flush();
  expect(mod.store.getState().book.bids[1].sz).toBe("7.00000");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  // Blank rows refetch at once, one at a time.
  feeds.fast(book([["84", "1"]], true) as never); // 84 + 8 deeper ones left
  flush();
  feeds.fast(book([["84", "2"]], true) as never);
  flush();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  reply(book(ladder(84, 20, "7"), false, 25));
  await settle();
  flush();
  expect(mod.store.getState().book.bids[11].sz).toBe("7.00000");

  // A side with under 20 deep levels is exhausted: no refill, blank rows.
  feeds.deep(book(ladder(95, 10), false, 30) as never);
  vi.setSystemTime(Date.now() + 1_100);
  flush();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(mod.store.getState().loading).toBe(false);
  vi.useRealTimers();
});

it("drops a refill reply that lands after a resubscribe", async () => {
  feeds.deep(book(ladder(100, 20), false, 10) as never);
  feeds.fast(book([["90", "1"]], true) as never);
  flush(); // a short side with a full deep snapshot: refill in flight
  expect(fetchMock).toHaveBeenCalledTimes(1);
  mod.setPrecision(2);
  reply(book([["100", "7"], ["99", "7"]], false, 20)); // newer and well-formed, but for the old grouping
  await new Promise((r) => setTimeout(r, 0));
  flush();
  expect(bidSizes()).toEqual(["", "", ""]);
});

it("drops snapshots that aren't at the subscribed grouping, even after the ACK", () => {
  mod.setPrecision(3); // step 100 at these prices
  const level = (px: number) => ({ px: `${px}`, sz: "1", n: 1 });
  const grouped = (step: number): WireL2Book => ({
    coin: "BTC",
    time: 0,
    levels: [[level(83000), level(83000 - step)], [level(83000 + step)]],
    spread: "1.0",
  });
  feeds.fast(book([["83000", "1"]], true) as never); // full precision: no spread field
  feeds.deep(grouped(1000) as never); // coarser
  flush();
  expect(bidSizes()).toEqual(["", "", ""]);
  feeds.deep(grouped(100) as never);
  flush();
  expect(mod.store.getState().book.bids.slice(0, 2).map((s) => s.px)).toEqual(["83,000", "82,900"]);
});

it("flashes a changed level, never the first frame, and clears flashes when the tab switches", () => {
  const flashes = () => mod.store.getState().book.bids.slice(0, 2).map((s) => s.flash);
  feeds.deep(book(ladder(100, 6)) as never);
  feeds.fast(book(ladder(100, 2), true) as never);
  flush();
  expect(flashes()).toEqual([0, 0]);
  feeds.fast(book([["100", "9"], ["99", "90"]], true) as never);
  flush();
  expect(flashes()).toEqual([0, 1]);
  mod.setTab("trades");
  expect(flashes()).toEqual([0, 0]);
});

it("clears the grouping labels on a coin switch, keeps them on a precision switch", () => {
  feeds.fast(book([["83000", "1"]], true) as never);
  flush();
  const labels = () => mod.store.getState().book.groupings.map((g) => g.label);
  expect(labels()).toEqual(["1,000", "100", "10", "1"]);
  mod.setPrecision(2);
  expect([labels(), mod.store.getState().book.tick]).toEqual([["1,000", "100", "10", "1"], "1,000"]);
  mod.setCoin("ETH");
  expect(labels()).toEqual([]);
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
  emitStatus("offline");
  emitStatus("live");
  feeds.trades([trade(35)] as never); // a new list after a drop starts at the top
  flush();
  expect([top(), tradeCount()]).toEqual([0, 1]);
  feeds.trades(fills(36, 30) as never);
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
  mod.holdTrades(true);
  emitStatus("offline");
  emitStatus("live");
  feeds.trades(fills(34, 20) as never); // a new list after a drop still starts at the top
  flush();
  expect(top()).toBe(0);
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
