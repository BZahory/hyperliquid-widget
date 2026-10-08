import { describe, expect, it } from "vitest";
import {
  DEPTH,
  deriveBook,
  deriveTrades,
  EMPTY_BOOK,
  fitsGrouping,
  HISTORY,
  mergeSnapshots,
  prependTrades,
  type DeriveOptions,
} from "./derive";
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
    expect(book.bids[1]).toMatchObject({ px: "", sz: "", total: "", ratio: 0, pxFull: "", szFull: "", totalFull: "", avg: "", flash: 0 });
    expect(EMPTY_BOOK.asks).toHaveLength(DEPTH);
  });

  it("accumulates per side and scales both sides by one shared max", () => {
    const book = derive(snap([["100.0", "1"], ["99.0", "2"], ["98.0", "3"]], [["101.0", "1"], ["102.0", "1"]]));
    expect(book.bids.slice(0, 3).map((s) => s.total)).toEqual(["1.00000", "3.00000", "6.00000"]);
    expect(book.asks.slice(0, 2).map((s) => s.total)).toEqual(["1.00000", "2.00000"]);
    expect(book.bids.slice(0, 3).map((s) => s.ratio)).toEqual([1 / 6, 3 / 6, 1]);
    expect(book.asks.slice(0, 2).map((s) => s.ratio)).toEqual([1 / 6, 2 / 6]);
    expect(book.bidShare).toBe(0.75);
  });

  it("only uses the displayed depth for cumulative totals", () => {
    const bids: [string, string][] = Array.from({ length: 20 }, (_, i) => [`${100 - i}.0`, "1"]);
    const book = derive(snap(bids, [["101.0", "1"]]));
    expect(book.bids[DEPTH - 1].total).toBe(`${DEPTH}.00000`);
    expect(book.bids[DEPTH - 1].ratio).toBe(1);
  });

  it("formats prices with thousands separators and the decimals of the step, whichever prices are shown", () => {
    expect(derive(snap([["83452.0", "1"]], [["83453.0", "1"]])).bids[0].px).toBe("83,452");
    const book = derive(snap([["2568.0", "1"]], [["2568.1", "1"]]), null, eth);
    expect(book.bids[0].px).toBe("2,568.0");
    expect(book.asks[0].px).toBe("2,568.1");
    expect(derive(snap([["2568.0", "1"]], [["2569.0", "1"]]), null, eth).bids[0].px).toBe("2,568.0"); // tick 0.1
    expect(derive(snap([["2560.0", "1"]], [["2570.0", "1"]]), null, { ...eth, nSigFigs: 3 }).bids[0].px).toBe("2,560"); // step 10
    // A book straddling a power of ten takes its deepest price's decimals.
    const straddle = derive(snap([["1000.1", "1"], ["999.95", "1"]], [["1000.2", "1"]]), null, eth);
    expect(straddle.bids.slice(0, 2).map((s) => s.px)).toEqual(["1,000.10", "999.95"]);
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
    // Always at full precision's decimals, so the cell keeps its width as the spread moves.
    const ethGrouped = (spread: string) => derive({ ...snap([["2560.0", "1"]], [["2570.0", "1"]]), spread }, null, { ...eth, nSigFigs: 3 }).spread;
    expect([ethGrouped("0.1"), ethGrouped("1.0")]).toEqual(["0.1", "1.0"]);
    expect(mergeSnapshots(grouped, snap([["82000.0", "1"]], [["85000.0", "1"]]), true)!.spread).toBe("1.0");
  });

  it("leaves spread blank when a side is empty", () => {
    const book = derive(snap([], [["101.0", "1"]]));
    expect(book).toMatchObject({ spread: "", spreadPct: "", spreadFull: "", spreadPctFull: "" });
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

  it("shows a non-zero notional under half a dollar as <1, not 0", () => {
    const book = derive(snap([["2568.1", "0.0001"], ["2568.0", "0.0002"]], [["2568.2", "0.0004"]]), null, { ...eth, quote: true });
    expect(book.bids.slice(0, 2).map((s) => [s.sz, s.total])).toEqual([["<1", "<1"], ["1", "1"]]);
    expect(book.bids[0].szFull).toBe("0.25681");
  });

  it("quote mode accumulates each level's own notional and scales bars by it", () => {
    const book = derive(snap([["2500.0", "1"], ["2400.0", "1"], ["2300.0", "1"]], [["2600.0", "2"]]), null, { ...opts, quote: true });
    expect(book.bids.slice(0, 3).map((s) => s.total)).toEqual(["2,500", "4,900", "7,200"]);
    expect(book.asks[0]).toMatchObject({ sz: "5,200", total: "5,200" });
    expect(book.bids[2].ratio).toBe(1);
    expect(book.asks[0].ratio).toBeCloseTo(5200 / 7200);
  });

  it("sums and multiplies wire decimals exactly", () => {
    // 0.1 + 0.2 and 2568.7 × 0.1234 are inexact in floating point.
    const book = snap([["2568.7", "0.1"], ["2568.6", "0.2"]], [["2568.8", "0.1234"]]);
    expect(derive(book, null, eth).bids[1].totalFull).toBe("0.3");
    expect(derive(book, null, { ...eth, quote: true }).bids[1].totalFull).toBe("770.59");
    expect(derive(book, null, { ...eth, quote: true }).asks[0].totalFull).toBe("316.98992");
    // A float product drops the last digit here (…329.78204).
    const big = snap([["123456.7", "98765.43217"]], [["123457.0", "1"]]);
    expect(derive(big, null, { ...opts, quote: true }).bids[0].totalFull).toBe("12,193,254,329.782039");
  });

  it("fills the tooltip: sweep total in the selected unit and average fill, approximate when grouped", () => {
    const wire = snap([["100.0", "1"], ["99.0", "3"]], [["101.0", "2"]]);
    const book = derive(wire);
    expect(book.bids[0]).toMatchObject({ avg: "100", totalFull: "1" });
    expect(book.bids[1]).toMatchObject({ avg: "99.25", totalFull: "4" });
    expect(derive(wire, null, { ...opts, quote: true }).bids[1].totalFull).toBe("397");
    expect(derive(wire, null, { ...opts, nSigFigs: 2 }).bids[1].avg).toBe("≈99");
  });

  it("reveals each number's full value in the selected unit, exactly, and marks approximate ones", () => {
    const wire = snap([["2568.1", "0.12345"]], [["2568.2", "0.1234"]]);
    expect(derive(wire, null, eth).bids[0]).toMatchObject({ px: "2,568.1", sz: "0.1235", pxFull: "2,568.1", szFull: "0.12345" });
    // In float, 2568.2 × 0.1234 = 316.91587999999996 and 2568.2 − 2568.1 = 0.09999999999990905.
    const book = derive(wire, null, { ...eth, quote: true });
    expect(book.asks[0]).toMatchObject({ sz: "317", szFull: "316.91588", totalFull: "316.91588" });
    expect(book).toMatchObject({ spread: "0.1", spreadFull: "0.1", spreadPctFull: "0.00389385%" });
    // Grouped: USD values come from bucket prices and the mid is a bucket mid.
    const grouped = derive({ ...wire, spread: "0.1" }, null, { ...eth, quote: true, nSigFigs: 3 });
    expect(grouped.asks[0]).toMatchObject({ szFull: "≈316.91588", totalFull: "≈316.91588" });
    expect(grouped).toMatchObject({ spreadFull: "0.1", spreadPctFull: "≈0.00389385%" });
    expect(derive(wire, null, { ...eth, nSigFigs: 3 }).bids[0].szFull).toBe("0.12345");
    expect(derive(snap([["100.0", "1"]], [["101.0", "2"]]))).toMatchObject({ spreadFull: "1", spreadPctFull: "0.99502488%" });
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

describe("fitsGrouping", () => {
  const grouped = (step: number, spread = "1.0") => ({
    ...snap([0, 1, 2].map((i) => [`${83000 - i * step}.0`, "1"]), [0, 1, 2].map((i) => [`${83000 + (i + 1) * step}.0`, "1"])),
    spread,
  });

  it("tells full precision from grouped books by the spread field grouped ones carry", () => {
    expect(fitsGrouping(snap([["83452.0", "1"]], [["83453.0", "1"]]), null, 5)).toBe(true);
    expect(fitsGrouping(grouped(1000), null, 5)).toBe(false);
    expect(fitsGrouping(snap([["83452.0", "1"]], [["83453.0", "1"]]), 4, 5)).toBe(false);
  });

  it("rejects a book at a finer or a coarser step than the grouping's", () => {
    expect(fitsGrouping(grouped(100), 3, 5)).toBe(true);
    expect(fitsGrouping(grouped(10), 3, 5)).toBe(false); // finer: off the 100 grid
    expect(fitsGrouping(grouped(1000), 3, 5)).toBe(false); // coarser: on it, but every price on 1,000
  });

  it("accepts either step when the touch straddles a power of ten", () => {
    const at = (step: number) => ({ ...snap([[`${100000 - step}.0`, "1"]], [["100000.0", "1"], [`${100000 + step}.0`, "1"]]), spread: "1.0" });
    expect([fitsGrouping(at(100), 3, 5), fitsGrouping(at(1000), 3, 5)]).toEqual([true, true]);
  });
});

describe("mergeSnapshots", () => {
  const fast = snap([["100.0", "1"], ["99.9", "1"]], [["100.1", "1"], ["100.2", "1"]]);
  const deep = snap(
    [["100.1", "9"], ["100.0", "9"], ["99.9", "9"], ["99.8", "9"], ["99.7", "9"]],
    [["100.0", "9"], ["100.1", "9"], ["100.2", "9"], ["100.3", "9"], ["100.4", "9"]],
  );

  it("returns whichever snapshot exists when the other is missing", () => {
    expect(mergeSnapshots(fast, null, false)).toBe(fast);
    expect(mergeSnapshots(null, deep, false)).toBe(deep);
    expect(mergeSnapshots(null, null, false)).toBeNull();
  });

  it("keeps fast levels verbatim and appends only deep levels beyond them", () => {
    const merged = mergeSnapshots(fast, deep, false)!;
    expect(merged.levels[0].map((l) => `${l.px}@${l.sz}`)).toEqual(["100.0@1", "99.9@1", "99.8@9", "99.7@9"]);
    expect(merged.levels[1].map((l) => `${l.px}@${l.sz}`)).toEqual(["100.1@1", "100.2@1", "100.3@9", "100.4@9"]);
  });

  it("drops every deep level overlapping the fast range after a sharp move", () => {
    // Price fell: the deep snapshot's asks all sit above the fast top, its bids all overlap.
    const moved = mergeSnapshots(snap([["95.0", "1"], ["94.9", "1"]], [["95.1", "1"], ["95.2", "1"]]), deep, false)!;
    expect(moved.levels[0].map((l) => l.px)).toEqual(["95.0", "94.9"]);
    expect(moved.levels[1].map((l) => l.px)).toEqual(["95.1", "95.2", "100.0", "100.1", "100.2", "100.3", "100.4"]);
  });

  it("falls back to the whole deep side when the fast side is empty", () => {
    const merged = mergeSnapshots(snap([], [["100.1", "1"]]), deep, false)!;
    expect(merged.levels[0]).toHaveLength(5);
  });

  it("doesn't merge grouped books at different steps (the price crossed a power of ten between them)", () => {
    const fine = snap([["99900.0", "1"], ["99800.0", "1"]], [["100000.0", "1"]]); // step 100
    const coarse = snap([["99000.0", "9"], ["98000.0", "9"]], [["100000.0", "9"], ["101000.0", "9"]]); // step 1000
    expect(mergeSnapshots(fine, coarse, true)).toBe(fine);
    expect(mergeSnapshots(fine, snap([["99700.0", "9"]], [["100100.0", "9"]]), true)!.levels[0]).toHaveLength(3);
  });
});

describe("trades", () => {
  const hash = "0xfb5f323f3c5e7f10fcd804461f7c590207680024d7519de39f27dd91fb5258fb"; // a real BTC fill
  const trade = (px: string, sz: string, side: "A" | "B", time = 1_791_400_000_000): WireTrade => ({ coin: "BTC", side, px, sz, time, hash, tid: time });

  it("prepends a wire batch newest-first and caps the history", () => {
    const recent = prependTrades([trade("1.0", "1", "B", 1)], [trade("2.0", "1", "A", 2), trade("3.0", "1", "B", 3)]);
    expect(recent.map((t) => t.px)).toEqual(["3.0", "2.0", "1.0"]);
    const many = Array.from({ length: HISTORY + 5 }, (_, i) => trade(`${i}.0`, "1", "B", i));
    expect(prependTrades([], many)).toHaveLength(HISTORY);
  });

  it("formats one row per fill, keyed by tid, in arrival order, linking its transaction on the explorer", () => {
    const slots = deriveTrades([trade("83452.0", "0.5", "B", 7), trade("83451.0", "0.25", "A", 8)], 41, { szDecimals: 5, quote: false });
    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.seq)).toEqual([41, 40]);
    expect(slots[0]).toMatchObject({ id: 7, px: "83,452", sz: "0.50000", side: "buy", pxFull: "83,452", szFull: "0.5" });
    expect(slots[0].href).toBe(`https://app.hyperliquid.xyz/explorer/tx/${hash}`);
    expect(slots[0].time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(slots[1]).toMatchObject({ id: 8, px: "83,451", sz: "0.25000", side: "sell", szFull: "0.25" });
  });

  it("links no transaction for a TWAP or liquidation fill (all-zero hash) or a malformed hash", () => {
    const link = (h: string) => deriveTrades([{ ...trade("83452.0", "1", "B"), hash: h }], 0, { szDecimals: 5, quote: false })[0].href;
    expect(link(`0x${"0".repeat(64)}`)).toBe("");
    expect(link("0x12/../../evil")).toBe("");
  });

  it("formats trade prices at the tick's decimals", () => {
    const eth = (...px: string[]) => deriveTrades(px.map((p, i) => ({ ...trade(p, "1", "B"), coin: "ETH", tid: i })), 0, { szDecimals: 4, quote: false });
    expect(eth("2569.0", "2570.0").slice(0, 2).map((s) => s.px)).toEqual(["2,569.0", "2,570.0"]);
    expect(eth("2569.9", "2570.0").slice(0, 2).map((s) => s.px)).toEqual(["2,569.9", "2,570.0"]);
  });

  it("shows trade sizes in quote currency when asked: rounded in the cell, exact on hover", () => {
    const [slot] = deriveTrades([trade("2568.7", "0.1234", "B")], 0, { szDecimals: 4, quote: true });
    expect(slot).toMatchObject({ sz: "317", szFull: "316.97758" });
    expect(deriveTrades([trade("2569.1", "0.0001", "B")], 0, { szDecimals: 4, quote: true })[0].sz).toBe("<1");
    const [big] = deriveTrades([trade("123456.7", "98765.43217", "A")], 0, { szDecimals: 5, quote: true });
    expect(big.szFull).toBe("12,193,254,329.782039"); // float: …329.78204
  });
});
