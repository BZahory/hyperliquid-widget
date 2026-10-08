import { describe, expect, it } from "vitest";
import { DEPTH, deriveBook, deriveTrades, EMPTY_BOOK, EMPTY_TRADES, mergeSnapshots, prependTrades, TRADES, type DeriveOptions } from "./derive";
import type { DisplayBook, WireL2Book, WireLevel, WireTrade } from "./types";

const level = (px: string, sz: string): WireLevel => ({ px, sz, n: 1 });
const snap = (bids: [string, string][], asks: [string, string][]): WireL2Book => ({
  coin: "BTC",
  time: 0,
  levels: [bids.map(([px, sz]) => level(px, sz)), asks.map(([px, sz]) => level(px, sz))],
});
const opts: DeriveOptions = { szDecimals: 5, nSigFigs: null, quote: false };
const eth: DeriveOptions = { szDecimals: 4, nSigFigs: null, quote: false };
const derive = (s: WireL2Book, prev: DisplayBook | null = null, o = opts) => deriveBook(s, prev ?? EMPTY_BOOK, o);

describe("deriveBook", () => {
  it("pads every side to DEPTH slots and keeps EMPTY_BOOK the same shape", () => {
    const book = derive(snap([["100.0", "1"]], [["101.0", "1"], ["102.0", "1"]]));
    expect(book.bids).toHaveLength(DEPTH);
    expect(book.asks).toHaveLength(DEPTH);
    expect(book.bids[1]).toEqual(EMPTY_BOOK.bids[0]);
    expect(book.bids[1]).toMatchObject({ px: "", sz: "", total: "", ratio: 0, flash: 0 });
    expect(EMPTY_BOOK.asks).toHaveLength(DEPTH);
  });

  it("accumulates per side and scales both sides by one shared max", () => {
    const book = derive(snap([["100.0", "1"], ["99.0", "2"], ["98.0", "3"]], [["101.0", "1"], ["102.0", "1"]]));
    expect(book.bids.slice(0, 3).map((s) => s.total)).toEqual(["1.00000", "3.00000", "6.00000"]);
    expect(book.asks.slice(0, 2).map((s) => s.total)).toEqual(["1.00000", "2.00000"]);
    expect(book.bids.slice(0, 3).map((s) => s.ratio)).toEqual([1 / 6, 3 / 6, 1]);
    expect(book.asks.slice(0, 2).map((s) => s.ratio)).toEqual([1 / 6, 2 / 6]);
  });

  it("only uses the displayed depth for cumulative totals", () => {
    const bids: [string, string][] = Array.from({ length: 20 }, (_, i) => [`${100 - i}.0`, "1"]);
    const book = derive(snap(bids, [["101.0", "1"]]));
    expect(book.bids[DEPTH - 1].total).toBe(`${DEPTH}.00000`);
    expect(book.bids[DEPTH - 1].ratio).toBe(1);
  });

  it("formats prices with thousands separators and the snapshot's shared decimals", () => {
    expect(derive(snap([["83452.0", "1"]], [["83453.0", "1"]])).bids[0].px).toBe("83,452");
    const book = derive(snap([["2568.0", "1"]], [["2568.1", "1"]]), null, eth);
    expect(book.bids[0].px).toBe("2,568.0"); // padded to match the 1-decimal neighbour
    expect(book.asks[0].px).toBe("2,568.1");
  });

  it("formats a dot-less wire price", () => {
    expect(derive(snap([["83452", "1"]], [["83453", "1"]])).bids[0].px).toBe("83,452");
  });

  it("reports spread and spread %", () => {
    const book = derive(snap([["83450.0", "1"], ["83440.0", "1"]], [["83460.0", "1"], ["83470.0", "1"]]));
    expect(book.spread).toBe("10");
    expect(book.spreadPct).toBe("0.012%");
    expect(derive(snap([["2568.1", "1"]], [["2568.2", "1"]])).spread).toBe("0.1");
  });

  it("uses the wire's full-precision spread when grouped", () => {
    const grouped = { ...snap([["83000.0", "1"]], [["84000.0", "1"]]), spread: "1.0" };
    expect(derive(grouped, null, { ...opts, nSigFigs: 2 })).toMatchObject({ spread: "1", spreadPct: "0.001%" });
    const ethGrouped = { ...snap([["2560.0", "1"]], [["2570.0", "1"]]), spread: "0.1" };
    expect(derive(ethGrouped, null, { ...opts, nSigFigs: 3 }).spread).toBe("0.1");
    expect(mergeSnapshots(grouped, snap([["82000.0", "1"]], [["85000.0", "1"]]))!.spread).toBe("1.0");
  });

  it("leaves spread blank when a side is empty", () => {
    const book = derive(snap([], [["101.0", "1"]]));
    expect(book).toMatchObject({ spread: "", spreadPct: "" });
  });

  it("derives the grouping tick from nSigFigs and price magnitude, not from level gaps", () => {
    const thin = snap([["83450.0", "1"], ["83447.0", "1"]], [["83453.0", "1"]]); // gaps of 3
    expect(derive(thin).tick).toBe("1");
    expect(derive(thin, null, { ...opts, nSigFigs: 4 }).tick).toBe("10");
    expect(derive(thin, null, { ...opts, nSigFigs: 2 }).tick).toBe("1,000");
    expect(derive(snap([["2568.0", "1"]], [["2568.0", "1"]]), null, eth).tick).toBe("0.1");
    expect(derive(snap([["2568.0", "1"]], [["2568.0", "1"]]), null, { ...eth, nSigFigs: 3 }).tick).toBe("10");
    expect(derive(snap([["123456.0", "1"]], [["123457.0", "1"]])).tick).toBe("1"); // integers always allowed
    expect(derive(snap([["123456.0", "1"]], [["123457.0", "1"]]), null, { ...opts, nSigFigs: 5 }).tick).toBe("10");
  });

  it("labels precision options by price step, lists each step once, and reuses the array when unchanged", () => {
    // At ~83k, nSigFigs 5 and full precision are both 1, so only full precision is offered.
    const btc = derive(snap([["83452.0", "1"]], [["83453.0", "1"]]));
    expect(btc.groupings).toEqual([
      { value: 2, label: "1,000" },
      { value: 3, label: "100" },
      { value: 4, label: "10" },
      { value: null, label: "1" },
    ]);
    expect(derive(snap([["83450.0", "1"]], [["83451.0", "1"]]), btc).groupings).toBe(btc.groupings);
    const labels = (bid: string, ask: string, o = eth) => derive(snap([[bid, "1"]], [[ask, "1"]]), null, o).groupings.map((g) => g.label);
    expect(labels("2568.1", "2568.2")).toEqual(["100", "10", "1", "0.1"]);
    expect(labels("999.95", "999.96")).toEqual(["10", "1", "0.1", "0.01"]);
    // Above 100k, nSigFigs 5 and full precision diverge, so both are offered.
    expect(labels("123456.0", "123457.0", opts)).toEqual(["10,000", "1,000", "100", "10", "1"]);
  });

  it("quote mode accumulates each level's own notional and scales bars by it", () => {
    const book = derive(snap([["2500.0", "1"], ["2400.0", "1"], ["2300.0", "1"]], [["2600.0", "2"]]), null, { ...opts, quote: true });
    expect(book.bids.slice(0, 3).map((s) => s.total)).toEqual(["2,500", "4,900", "7,200"]);
    expect(book.asks[0]).toMatchObject({ sz: "5,200", total: "5,200" });
    expect(book.bids[2].ratio).toBe(1);
    expect(book.asks[0].ratio).toBeCloseTo(5200 / 7200);
  });
});

describe("flashes", () => {
  // Four levels and a dust tail.
  const dust: [string, string][] = [96, 95, 94, 93, 92, 91].map((px) => [`${px}.0`, "0.01"]);
  const top: [string, string][] = [["100.0", "20"], ["99.0", "20"], ["98.0", "1"], ["97.0", "1"]];
  const before = snap(top.concat(dust), [["101.0", "1"], ["102.0", "1"], ["103.0", "1"]]);
  const bidsOf = (bids: [string, string][]): WireL2Book => ({ ...before, levels: [snap(bids, []).levels[0], before.levels[1]] });
  const flashes = (next: WireL2Book, live: [number, number] = [DEPTH, DEPTH], prev = derive(before)) =>
    deriveBook(next, prev, opts, { before, live }).bids.map((s) => s.flash);

  it("never on a first snapshot", () => {
    expect(derive(before).bids.every((s) => s.flash === 0)).toBe(true);
  });

  it("when a level's size at least doubles or halves by at least two average levels", () => {
    // Two average levels are 18.4: 20 → 40 flashes, 20 → 39 isn't double, 1 → 12 is too small.
    const next = bidsOf([["100.0", "40"], ["99.0", "39"], ["98.0", "12"], ["97.0", "1"], ...dust]);
    expect(flashes(next).slice(0, 4)).toEqual([1, 0, 0, 0]);
  });

  it("not when the change is under two average levels, as for a dust order at a new price", () => {
    const next = bidsOf([["100.5", "0.05"], ...top, ["96.0", "0.5"], ...dust.slice(1)]);
    expect(flashes(next).every((f) => f === 0)).toBe(true);
  });

  it("for a new level inside the known range, not for depth only just learned beyond it", () => {
    const next = bidsOf([["100.5", "12"], ...top, ...dust, ["90.0", "12"]]);
    expect(flashes(next)).toEqual([1, ...Array(DEPTH - 1).fill(0)]);
  });

  it("only within the fast window, and counts on per slot so each flash restarts", () => {
    const next = bidsOf([["100.0", "5"], ["99.0", "5"], ...top.slice(2), ...dust]);
    expect(flashes(next, [2, 0]).slice(0, 4)).toEqual([1, 1, 0, 0]);
    const once = deriveBook(next, derive(before), opts, { before, live: [2, 0] });
    expect(flashes(next, [2, 0], once).slice(0, 4)).toEqual([2, 2, 0, 0]);
    expect(deriveBook(next, once, opts).bids[0].flash).toBe(1); // carried on when nothing changed
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

  it("keeps a shifted row's flash direction, so a side change below the fresh fills never restarts it", () => {
    const first = deriveTrades([trade("2.0", "1", "A"), trade("1.0", "1", "B")], 2, EMPTY_TRADES, { szDecimals: 5, quote: false });
    expect(first.map((t) => t.flash).slice(0, 2)).toEqual(["down", "up"]);
    const next = deriveTrades([trade("3.0", "1", "B"), trade("2.0", "1", "A"), trade("1.0", "1", "B")], 1, first, { szDecimals: 5, quote: false });
    expect(next[0]).toMatchObject({ side: "buy", flash: "up", flashSeq: 2 });
    expect(next[1]).toMatchObject({ side: "sell", flash: "up", flashSeq: 1 }); // shifted in, slot unchanged
  });

  it("shows trade sizes in quote currency when asked", () => {
    const [slot] = deriveTrades([trade("2500.0", "2", "B")], 0, EMPTY_TRADES, { szDecimals: 4, quote: true });
    expect(slot.sz).toBe("5,000");
  });
});
