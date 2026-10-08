import { beforeEach, expect, it, vi } from "vitest";
import type { WireL2Book } from "./types";

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
const bidSizes = () => mod.store.getState().book.bids.slice(0, 3).map((s) => s.sz);

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
