import { describe, expect, it } from "vitest";
import { DEPTH, deriveBook, deriveTrades, EMPTY_BOOK, EMPTY_TRADES, mergeSnapshots, prependTrades, TRADES, type Derived, type DeriveOptions } from "./derive";
import type { WireL2Book, WireLevel, WireTrade } from "./types";

const level = (px: string, sz: string): WireLevel => ({ px, sz, n: 1 });
const snap = (bids: [string, string][], asks: [string, string][]): WireL2Book => ({
  coin: "BTC",
  time: 0,
  levels: [bids.map(([px, sz]) => level(px, sz)), asks.map(([px, sz]) => level(px, sz))],
});
const opts: DeriveOptions = { szDecimals: 5, nSigFigs: null, quote: false };
const derive = (s: WireL2Book, prev: Derived | null = null, o = opts) => deriveBook(s, prev, o);

describe("deriveBook", () => {
  it("pads every side to DEPTH slots and keeps EMPTY_BOOK the same shape", () => {
    const { book } = derive(snap([["100.0", "1"]], [["101.0", "1"], ["102.0", "1"]]));
    expect(book.bids).toHaveLength(DEPTH);
    expect(book.asks).toHaveLength(DEPTH);
    expect(book.bids[1]).toEqual({ px: "", sz: "", total: "", ratio: 0, flash: "", flashSeq: 0 });
    expect(book.asks[2].px).toBe("");
    expect(EMPTY_BOOK.asks).toHaveLength(DEPTH);
  });

  it("accumulates per side and scales both sides by one shared max", () => {
    const { book } = derive(snap([["100.0", "1"], ["99.0", "2"], ["98.0", "3"]], [["101.0", "1"], ["102.0", "1"]]));
    expect(book.bids.slice(0, 3).map((s) => s.total)).toEqual(["1.00000", "3.00000", "6.00000"]);
    expect(book.asks.slice(0, 2).map((s) => s.total)).toEqual(["1.00000", "2.00000"]);
    expect(book.bids.slice(0, 3).map((s) => s.ratio)).toEqual([1 / 6, 3 / 6, 1]);
    expect(book.asks.slice(0, 2).map((s) => s.ratio)).toEqual([1 / 6, 2 / 6]);
  });

  it("only uses the displayed depth for cumulative totals", () => {
    const bids: [string, string][] = Array.from({ length: 20 }, (_, i) => [`${100 - i}.0`, "1"]);
    const { book } = derive(snap(bids, [["101.0", "1"]]));
    expect(book.bids[DEPTH - 1].total).toBe(`${DEPTH}.00000`);
    expect(book.bids[DEPTH - 1].ratio).toBe(1);
  });

  it("formats prices with thousands separators and the snapshot's shared decimals", () => {
    const btc = derive(snap([["83452.0", "1"]], [["83453.0", "1"]])).book;
    expect(btc.bids[0].px).toBe("83,452");
    const eth = derive(snap([["2568.0", "1"]], [["2568.1", "1"]])).book;
    expect(eth.bids[0].px).toBe("2,568.0"); // padded to match the 1-decimal neighbour
    expect(eth.asks[0].px).toBe("2,568.1");
  });

  it("reports spread and spread %", () => {
    const { book } = derive(snap([["83450.0", "1"], ["83440.0", "1"]], [["83460.0", "1"], ["83470.0", "1"]]));
    expect(book.spread).toBe("10");
    expect(book.spreadPct).toBe("0.012%");
    const eth = derive(snap([["2568.1", "1"]], [["2568.2", "1"]])).book;
    expect(eth.spread).toBe("0.1");
  });

  it("derives the grouping tick from nSigFigs and price magnitude, not from level gaps", () => {
    const thin = snap([["83450.0", "1"], ["83447.0", "1"]], [["83453.0", "1"]]); // gaps of 3
    expect(derive(thin).book.tick).toBe("1");
    expect(derive(thin, null, { ...opts, nSigFigs: 4 }).book.tick).toBe("10");
    expect(derive(thin, null, { ...opts, nSigFigs: 2 }).book.tick).toBe("1,000");
    const eth: DeriveOptions = { szDecimals: 4, nSigFigs: null, quote: false };
    expect(derive(snap([["2568.0", "1"]], [["2568.0", "1"]]), null, eth).book.tick).toBe("0.1");
    expect(derive(snap([["2568.0", "1"]], [["2568.0", "1"]]), null, { ...eth, nSigFigs: 3 }).book.tick).toBe("10");
    expect(derive(snap([["123456.0", "1"]], [["123457.0", "1"]])).book.tick).toBe("1"); // integers always allowed
  });

  it("labels precision options by price step, cut off at full precision, and reuses the array when unchanged", () => {
    const btc = derive(snap([["83452.0", "1"]], [["83453.0", "1"]]));
    expect(btc.book.groupings).toEqual([
      { value: 2, label: "1,000" },
      { value: 3, label: "100" },
      { value: 4, label: "10" },
      { value: null, label: "1 (full precision)" },
    ]);
    const again = derive(snap([["83450.0", "1"]], [["83451.0", "1"]]), btc);
    expect(again.book.groupings).toBe(btc.book.groupings);
    const eth: DeriveOptions = { szDecimals: 4, nSigFigs: null, quote: false };
    expect(derive(snap([["2568.1", "1"]], [["2568.2", "1"]]), null, eth).book.groupings.map((g) => g.label)).toEqual([
      "100",
      "10",
      "1",
      "0.1 (full precision)",
    ]);
    expect(derive(snap([["999.95", "1"]], [["999.96", "1"]]), null, eth).book.groupings.map((g) => g.label)).toEqual([
      "10",
      "1",
      "0.1",
      "0.01 (full precision)",
    ]);
  });

  it("formats a dot-less wire price", () => {
    expect(derive(snap([["83452", "1"]], [["83453", "1"]])).book.bids[0].px).toBe("83,452");
  });

  it("leaves spread blank when a side is empty", () => {
    const { book } = derive(snap([], [["101.0", "1"]]));
    expect(book.spread).toBe("");
    expect(book.spreadPct).toBe("");
  });

  it("does not flash on the first snapshot", () => {
    const { book } = derive(snap([["100.0", "1"]], [["101.0", "1"]]));
    expect(book.bids[0].flash).toBe("");
    expect(book.bids[0].flashSeq).toBe(0);
  });

  it("flashes up/down on size change, persists until the next change, and alternates parity", () => {
    const a = derive(snap([["100.0", "1"]], [["101.0", "1"]]));
    const b = derive(snap([["100.0", "2"]], [["101.0", "1"]]), a);
    expect(b.book.bids[0]).toMatchObject({ flash: "up", flashSeq: 1 });
    expect(b.book.asks[0]).toMatchObject({ flash: "", flashSeq: 0 });
    const c = derive(snap([["100.0", "1.5"]], [["101.0", "1"]]), b);
    expect(c.book.bids[0]).toMatchObject({ flash: "down", flashSeq: 2 });
    const d = derive(snap([["100.0", "1.5"]], [["101.0", "1"]]), c);
    expect(d.book.bids[0]).toMatchObject({ flash: "down", flashSeq: 2 }); // unchanged: no retrigger
    const e = derive(snap([["100.0", "1.6"]], [["101.0", "1"]]), d);
    expect(e.book.bids[0]).toMatchObject({ flash: "up", flashSeq: 3 });
  });

  it("treats a brand-new price level as an increase", () => {
    const a = derive(snap([["100.0", "1"]], [["101.0", "1"]]));
    const b = derive(snap([["100.5", "1"], ["100.0", "1"]], [["101.0", "1"]]), a);
    expect(b.book.bids[0]).toMatchObject({ px: "100.5", flash: "up", flashSeq: 1 });
    expect(b.book.bids[1].flash).toBe(""); // same price, same size, shifted a slot: no flash
  });

  it("does not mistake a level scrolling in from beyond DEPTH for a new one", () => {
    const bids: [string, string][] = Array.from({ length: 15 }, (_, i) => [`${100 - i}.0`, "1"]);
    const a = derive(snap(bids, [["101.0", "1"]]));
    const b = derive(snap(bids.slice(1), [["101.0", "1"]]), a);
    expect(b.book.bids[DEPTH - 1].px).toBe(`${100 - DEPTH}`);
    expect(b.book.bids[DEPTH - 1].flash).toBe("");
  });

  it("does not flash depth it only just learned about beyond the previous deepest level", () => {
    const fastOnly = derive(snap([["100.0", "1"], ["99.9", "1"]], [["100.1", "1"]]));
    const withDeep = derive(snap([["100.0", "1"], ["99.9", "1"], ["99.8", "5"], ["99.7", "5"]], [["100.1", "1"]]), fastOnly);
    expect(withDeep.book.bids.slice(0, 4).map((s) => s.flash)).toEqual(["", "", "", ""]);
    // ...but a price appearing inside the known range is new and flashes.
    const gapFilled = derive(snap([["100.0", "1"], ["99.9", "1"], ["99.85", "2"], ["99.8", "5"]], [["100.1", "1"]]), withDeep);
    expect(gapFilled.book.bids[2]).toMatchObject({ px: "99.85", flash: "up", flashSeq: 1 });
  });

  it("re-deriving the identical snapshot in quote mode keeps flash state and switches units", () => {
    const a = derive(snap([["100.0", "1"]], [["101.0", "1"]]));
    const changed = snap([["100.0", "2.4"]], [["101.0", "1"]]);
    const b = derive(changed, a);
    const c = derive(changed, b, { ...opts, quote: true });
    expect(c.book.bids[0]).toMatchObject({ sz: "240", total: "240", flash: "up", flashSeq: 1 });
    expect(c.book.asks[0].sz).toBe("101"); // 1 × 101.0, rounded to whole USD
  });

  it("quote mode accumulates each level's own notional and scales bars by it", () => {
    const { book } = derive(snap([["2500.0", "1"], ["2400.0", "1"], ["2300.0", "1"]], [["2600.0", "2"]]), null, {
      ...opts,
      quote: true,
    });
    expect(book.bids.slice(0, 3).map((s) => s.total)).toEqual(["2,500", "4,900", "7,200"]);
    expect(book.asks[0].total).toBe("5,200");
    expect(book.bids[2].ratio).toBe(1);
    expect(book.asks[0].ratio).toBeCloseTo(5200 / 7200);
  });

  it("does not flash when a previously empty side gains levels", () => {
    const a = derive(snap([], [["101.0", "1"]]));
    const b = derive(snap([["100.0", "1"], ["99.9", "1"]], [["101.0", "1"]]), a);
    expect(b.book.bids.slice(0, 2).map((s) => s.flash)).toEqual(["", ""]);
  });
});

describe("mergeSnapshots", () => {
  const fast = snap([["100.0", "1"], ["99.9", "1"]], [["100.1", "1"], ["100.2", "1"]]);
  const deep = snap(
    [["100.1", "9"], ["100.0", "9"], ["99.9", "9"], ["99.8", "9"], ["99.7", "9"]],
    [["100.0", "9"], ["100.1", "9"], ["100.2", "9"], ["100.3", "9"], ["100.4", "9"]],
  );

  it("returns whichever snapshot exists when the other is missing", () => {
    expect(mergeSnapshots(fast, null)).toBe(fast);
    expect(mergeSnapshots(null, deep)).toBe(deep);
    expect(mergeSnapshots(null, null)).toBeNull();
  });

  it("keeps fast levels verbatim and appends only deep levels beyond them", () => {
    const merged = mergeSnapshots(fast, deep)!;
    expect(merged.levels[0].map((l) => `${l.px}@${l.sz}`)).toEqual(["100.0@1", "99.9@1", "99.8@9", "99.7@9"]);
    expect(merged.levels[1].map((l) => `${l.px}@${l.sz}`)).toEqual(["100.1@1", "100.2@1", "100.3@9", "100.4@9"]);
  });

  it("drops every deep level overlapping the fast range after a sharp move", () => {
    // Price fell: the deep snapshot's asks all sit above the fast top, its bids all overlap.
    const moved = mergeSnapshots(snap([["95.0", "1"], ["94.9", "1"]], [["95.1", "1"], ["95.2", "1"]]), deep)!;
    expect(moved.levels[0].map((l) => l.px)).toEqual(["95.0", "94.9"]);
    expect(moved.levels[1].map((l) => l.px)).toEqual(["95.1", "95.2", "100.0", "100.1", "100.2", "100.3", "100.4"]);
  });

  it("falls back to the whole deep side when the fast side is empty", () => {
    const merged = mergeSnapshots(snap([], [["100.1", "1"]]), deep)!;
    expect(merged.levels[0]).toHaveLength(5);
  });
});

describe("trades", () => {
  const trade = (px: string, sz: string, side: "A" | "B", time = 1_791_400_000_000): WireTrade => ({ coin: "BTC", side, px, sz, time, tid: time });

  it("prepends a wire batch newest-first and caps the list at the visible rows", () => {
    const recent = prependTrades([trade("1.0", "1", "B", 1)], [trade("2.0", "1", "A", 2), trade("3.0", "1", "B", 3)]);
    expect(recent.map((t) => t.px)).toEqual(["3.0", "2.0", "1.0"]);
    const many = Array.from({ length: TRADES + 5 }, (_, i) => trade(`${i}.0`, "1", "B", i));
    expect(prependTrades([], many)).toHaveLength(TRADES);
  });

  it("formats trades, pads to TRADES slots, and flashes only the fresh leading slots", () => {
    const recent = [trade("83452.0", "0.5", "B"), trade("83451.0", "0.25", "A")];
    const first = deriveTrades(recent, 0, EMPTY_TRADES, { szDecimals: 5, quote: false });
    expect(first).toHaveLength(TRADES);
    expect(first[0]).toMatchObject({ px: "83,452", sz: "0.50000", side: "buy", flashSeq: 0 });
    expect(first[0].time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(first[1]).toMatchObject({ px: "83,451", sz: "0.25000", side: "sell", flashSeq: 0 });
    expect(first[2]).toMatchObject({ px: "", side: "" });

    const next = deriveTrades([trade("83453.0", "1", "B"), ...recent], 1, first, { szDecimals: 5, quote: false });
    expect(next[0]).toMatchObject({ px: "83,453", flashSeq: 1 });
    expect(next[1]).toMatchObject({ px: "83,452", flashSeq: 0 }); // shifted, not fresh
  });

  it("shows trade sizes in quote currency when asked", () => {
    const [slot] = deriveTrades([trade("2500.0", "2", "B")], 0, EMPTY_TRADES, { szDecimals: 4, quote: true });
    expect(slot.sz).toBe("5,000");
  });
});
