import { expect, it, vi } from "vitest";
import { boot, store } from "./store";
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

const book = (bids: [string, string][], fast = false): WireL2Book => ({
  coin: "BTC",
  time: 0,
  levels: [bids.map(([px, sz]) => ({ px, sz, n: 1 })), [{ px: "101", sz: "1", n: 1 }]],
  ...(fast && { fast }),
});
const bidSizes = () => store.getState().book.bids.slice(0, 3).map((s) => s.sz);

it("keeps a level's last fast size when it leaves the fast window, until the next deep snapshot", () => {
  boot();
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
