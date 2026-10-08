import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WireL2Book } from "./types";

class FakeWS {
  static OPEN = 1;
  static all: FakeWS[] = [];
  readyState = 0;
  sent: { method: string; subscription?: { type: string; fast?: boolean } }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    FakeWS.all.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(channel: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ channel, data }) });
  }
  ack(fast: boolean) {
    const subscription = { type: "l2Book", coin: "BTC", nSigFigs: null, mantissa: null, fast };
    this.recv("subscriptionResponse", { method: "subscribe", subscription });
  }
}

const snapshot: WireL2Book = { coin: "BTC", time: 0, levels: [[{ px: "100", sz: "1", n: 1 }], [{ px: "101", sz: "1", n: 1 }]], fast: true };
const fastSub = { type: "l2Book", coin: "BTC", nSigFigs: null, fast: true } as const;

let socket: typeof import("./socket");
let status = "";
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  FakeWS.all = [];
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("navigator", { onLine: true });
  socket = await import("./socket"); // fresh module state per test
  socket.onStatus((s) => (status = s));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Subscribe to the fast BTC book, start, and open the socket. */
function connect() {
  const got: WireL2Book[] = [];
  socket.subscribe(fastSub, (d) => got.push(d));
  socket.start();
  const ws = FakeWS.all[0];
  ws.open();
  return { got, ws };
}

it("drops data until the subscribe ACK, and goes live only when data is delivered", () => {
  const { got, ws } = connect();
  ws.recv("l2Book", snapshot);
  expect(got).toHaveLength(0);
  expect(status).toBe("connecting");
  ws.ack(true);
  ws.recv("l2Book", snapshot);
  expect(got).toHaveLength(1);
  expect(status).toBe("live");
});

it("keeps a fed socket live and pings only when due; a silent one is dropped within ~12s", () => {
  const { ws } = connect();
  ws.ack(true);
  for (let s = 0; s < 31; s++) {
    ws.recv("l2Book", snapshot);
    vi.advanceTimersByTime(1_000);
  }
  expect(status).toBe("live");
  expect(ws.sent.filter((m) => m.method === "ping")).toHaveLength(1);

  vi.advanceTimersByTime(9_000);
  expect(status).toBe("live");
  vi.advanceTimersByTime(3_000);
  expect(status).toBe("reconnecting");
  expect(ws.readyState).toBe(3);
});

it("resubscribes the whole registry on every open", () => {
  socket.subscribe({ ...fastSub, fast: false }, () => {});
  socket.subscribe({ type: "trades", coin: "BTC" }, () => {});
  const { ws } = connect();
  const subscribes = (w: FakeWS) => w.sent.filter((m) => m.method === "subscribe").map((m) => `${m.subscription!.type}:${m.subscription!.fast ?? ""}`);
  expect(subscribes(ws).sort()).toEqual(["l2Book:", "l2Book:true", "trades:"]);

  ws.onclose?.();
  expect(status).toBe("reconnecting");
  vi.advanceTimersByTime(1_000); // first backoff is 0.5-1s
  const next = FakeWS.all[1];
  next.open();
  expect(subscribes(next).sort()).toEqual(["l2Book:", "l2Book:true", "trades:"]);
});

it("fails open 5s after a subscribe whose ACK never arrives", () => {
  const { got, ws } = connect();
  vi.advanceTimersByTime(4_900);
  ws.recv("l2Book", snapshot);
  expect(got).toHaveLength(0);
  vi.advanceTimersByTime(200);
  ws.recv("l2Book", snapshot);
  expect(got).toHaveLength(1);
});

/** Milliseconds until the next socket is created (the backoff delay), in 100 ms steps. */
function nextSocketAfter() {
  const n = FakeWS.all.length;
  let ms = 0;
  while (FakeWS.all.length === n && ms < 60_000) {
    vi.advanceTimersByTime(100);
    ms += 100;
  }
  const ws = FakeWS.all[n];
  ws.open();
  ws.ack(true);
  return { ms, ws };
}

it("backs off up to 10s while connections die young, and resets only after 10s of stable data", () => {
  vi.spyOn(Math, "random").mockReturnValue(0.999); // the full, unjittered delay
  let { ws } = connect();
  ws.ack(true);
  const delays: number[] = [];
  for (let i = 0; i < 6; i++) {
    ws.recv("l2Book", snapshot); // one snapshot, then the server drops us
    ws.onclose?.();
    const next = nextSocketAfter();
    delays.push(next.ms);
    ws = next.ws;
  }
  expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);

  for (let s = 0; s <= 11; s++) {
    ws.recv("l2Book", snapshot); // 11s of steady data
    vi.advanceTimersByTime(1_000);
  }
  ws.onclose?.();
  expect(nextSocketAfter().ms).toBe(1_000);
});

it("retries a pending reconnect as soon as the tab becomes visible", () => {
  const { ws } = connect();
  ws.onclose?.();
  expect(FakeWS.all).toHaveLength(1);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(FakeWS.all).toHaveLength(2);
});
