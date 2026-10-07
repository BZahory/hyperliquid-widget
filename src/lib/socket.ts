import type { NSigFigs, WireL2Book, WireTrade } from "./types";

/** Owns the single mainnet socket: subscription registry, backoff + jitter reconnect, resubscribe on
 *  open, ping/watchdog, and offline/online/visibility handling so "live" is never shown over a dead link. */
export type Status = "connecting" | "live" | "reconnecting" | "offline";

export type Sub =
  | {
      type: "l2Book";
      coin: string;
      nSigFigs: NSigFigs;
      /** Verified live: `fast: true` pushes the top 5 levels ~2×/s; the default pushes 20 levels
       *  every ~5s. The store merges both. */
      fast: boolean;
    }
  | { type: "trades"; coin: string };

const WS_URL = "wss://api.hyperliquid.xyz/ws";
/** Server drops idle connections after 60s (measured); ping well inside that. */
const PING_MS = 30_000;
/** No snapshot for this long means the socket or the subscription is dead: drop and redo both. */
const STALE_MS = 45_000;
/** A blackholed route can leave the handshake pending for minutes; don't wait for it. */
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
/** If the subscribe ACK never shows up, start accepting data anyway rather than freeze. */
const ACK_TIMEOUT_MS = 2_000;

interface Entry {
  sub: Sub;
  onData: (data: never) => void;
  /** l2Book data doesn't echo nSigFigs, so old-grouping stragglers can follow a precision change.
   *  Verified live: they only arrive before the new subscription's ACK, so data is dropped until then. */
  acked: boolean;
  ackTimer: ReturnType<typeof setTimeout> | undefined;
}

const registry = new Map<string, Entry>();
const statusListeners = new Set<(s: Status) => void>();
let status: Status = "connecting";
let ws: WebSocket | null = null;
let attempt = 0;
let lastDataAt = 0;
let lastPingAt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let connectTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let started = false;

const keyOf = (sub: Sub) =>
  sub.type === "trades" ? `trades:${sub.coin}` : `l2Book:${sub.coin}:${sub.nSigFigs ?? "full"}:${sub.fast ? "fast" : "deep"}`;

function setStatus(next: Status) {
  if (next === status) return;
  status = next;
  statusListeners.forEach((l) => l(next));
}

export function onStatus(listener: (s: Status) => void) {
  statusListeners.add(listener);
  listener(status);
}

function send(method: "subscribe" | "unsubscribe", sub: Sub) {
  if (ws?.readyState !== WebSocket.OPEN) return; // onopen resubscribes everything in the registry
  // Unsubscribe must mirror the exact subscribe payload, so build it in one place.
  const subscription: Record<string, unknown> = { type: sub.type, coin: sub.coin };
  if (sub.type === "l2Book") {
    if (sub.nSigFigs !== null) subscription.nSigFigs = sub.nSigFigs;
    if (sub.fast) subscription.fast = true;
  }
  ws.send(JSON.stringify({ method, subscription }));
}

function armAck(entry: Entry) {
  entry.acked = false;
  clearTimeout(entry.ackTimer);
  entry.ackTimer = setTimeout(() => {
    entry.acked = true;
  }, ACK_TIMEOUT_MS);
}

/** Register interest; returns an unsubscribe. Re-subscribing a live key swaps the listener. */
export function subscribe(sub: Extract<Sub, { type: "l2Book" }>, onData: (data: WireL2Book) => void): () => void;
export function subscribe(sub: Extract<Sub, { type: "trades" }>, onData: (data: WireTrade[]) => void): () => void;
export function subscribe(sub: Sub, onData: Entry["onData"]): () => void {
  const key = keyOf(sub);
  const existing = registry.get(key);
  if (existing) {
    existing.onData = onData;
  } else {
    const entry: Entry = { sub, onData, acked: false, ackTimer: undefined };
    registry.set(key, entry);
    send("subscribe", sub);
    armAck(entry);
  }
  return () => {
    const entry = registry.get(key);
    if (entry?.onData !== onData) return; // already swapped or removed
    registry.delete(key);
    clearTimeout(entry.ackTimer);
    send("unsubscribe", sub);
  };
}

/** Hand `data` to every acked entry that matches; a message for a switched-away coin finds none and drops here. */
function deliver(match: (sub: Sub) => boolean, data: unknown): boolean {
  let delivered = false;
  for (const entry of registry.values()) {
    if (entry.acked && match(entry.sub)) {
      entry.onData(data as never);
      delivered = true;
    }
  }
  return delivered;
}

function onMessage(ev: MessageEvent<string>) {
  const msg = JSON.parse(ev.data);
  // Background tabs throttle timers past the server's idle cutoff; the message path is not
  // throttled, so ping from here when due.
  if (Date.now() - lastPingAt >= PING_MS) ping();
  if (msg.channel === "l2Book") {
    const data = msg.data as WireL2Book;
    const fast = data.fast === true;
    const delivered = deliver((s) => s.type === "l2Book" && s.coin === data.coin && s.fast === fast, data);
    // "Live" and the backoff reset follow snapshots reaching the book, not socket open or orphan
    // streams, so an accept-then-drop server cannot cause a tight loop.
    if (delivered) {
      lastDataAt = Date.now();
      attempt = 0;
      setStatus("live");
    }
  } else if (msg.channel === "trades") {
    const data = msg.data as WireTrade[];
    if (data.length) deliver((s) => s.type === "trades" && s.coin === data[0].coin, data);
  } else if (msg.channel === "subscriptionResponse" && msg.data.method === "subscribe") {
    // The echo is normalised (adds mantissa/fast), so match on our own fields, not deep equality.
    const echoed = msg.data.subscription;
    const entry = registry.get(keyOf({ ...echoed, nSigFigs: echoed.nSigFigs ?? null, fast: echoed.fast === true }));
    if (entry) {
      entry.acked = true;
      clearTimeout(entry.ackTimer);
    }
  }
  // Pongs deliberately don't feed the watchdog: they prove the socket, not the subscription.
}

function dropSocket() {
  clearInterval(pingTimer);
  clearTimeout(connectTimer);
  const socket = ws;
  ws = null;
  if (!socket) return;
  socket.onopen = socket.onmessage = socket.onclose = null;
  socket.close();
}

function scheduleReconnect() {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
  attempt++;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, base / 2 + Math.random() * (base / 2));
  setStatus(navigator.onLine ? "reconnecting" : "offline");
}

function ping() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  lastPingAt = Date.now();
  ws.send(JSON.stringify({ method: "ping" }));
}

/** Keep the server's idle timer at bay, and drop a socket whose snapshots have stopped. */
function tick() {
  if (Date.now() - lastDataAt > STALE_MS) {
    // Half-open socket (typically after laptop sleep): close() alone may hang on the handshake.
    dropSocket();
    scheduleReconnect();
    return;
  }
  ping();
}

function connect() {
  clearTimeout(reconnectTimer);
  if (ws) return;
  const socket = new WebSocket(WS_URL);
  ws = socket;
  connectTimer = setTimeout(() => {
    dropSocket();
    scheduleReconnect();
  }, CONNECT_TIMEOUT_MS);
  socket.onopen = () => {
    clearTimeout(connectTimer);
    lastDataAt = lastPingAt = Date.now(); // grace period until the first snapshot
    for (const entry of registry.values()) {
      send("subscribe", entry.sub);
      armAck(entry);
    }
    pingTimer = setInterval(tick, PING_MS);
  };
  socket.onmessage = onMessage;
  socket.onclose = () => {
    dropSocket();
    scheduleReconnect();
  };
}

export function start() {
  if (started) return;
  started = true;
  window.addEventListener("offline", () => {
    // navigator.onLine is only a hint and "online" may never fire, so keep retrying on the backoff schedule.
    dropSocket();
    scheduleReconnect();
  });
  window.addEventListener("online", () => {
    // Whatever socket exists was built on the old network; replace it now, not after backoff.
    dropSocket();
    attempt = 0;
    setStatus("reconnecting");
    connect();
  });
  document.addEventListener("visibilitychange", () => {
    // A handshake in flight has its own timeout; only an open socket gets the watchdog.
    if (document.visibilityState === "visible" && ws?.readyState === WebSocket.OPEN) tick();
  });
  connect();
}
