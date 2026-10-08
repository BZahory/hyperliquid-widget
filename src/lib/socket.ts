import type { NSigFigs, WireL2Book, WireTrade } from "./types";

/** The single mainnet socket: subscription registry, reconnect with backoff, resubscribe, ping and watchdog. */
export type Status = "connecting" | "live" | "reconnecting" | "offline";

export type Sub =
  | {
      type: "l2Book";
      coin: string;
      nSigFigs: NSigFigs;
      /** `fast: true` sends the top 5 levels ~2×/s instead of 20 every ~5 s; the store merges both. */
      fast: boolean;
    }
  | { type: "trades"; coin: string };

const WS_URL = "wss://api.hyperliquid.xyz/ws";
/** The server drops idle connections after 60 s. */
const PING_MS = 30_000;
/** No snapshot for this long means the socket or subscription is dead (live gaps peak at ~5.9 s). */
const STALE_MS = 10_000;
const TICK_MS = 2_000;
/** A blackholed route can leave the handshake pending for minutes. */
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 10_000;
/** Backoff resets only after this long of data, so a server that drops after one snapshot still backs off. */
const STABLE_MS = 10_000;
/** Accept data anyway if the ACK never arrives; inside STALE_MS so a lost ACK never forces a reconnect. */
const ACK_TIMEOUT_MS = 5_000;

interface Entry {
  sub: Sub;
  onData: (data: never) => void;
  /** Drop data until the ACK: most old-grouping stragglers arrive before it (the store drops the rest). */
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
let openedAt = 0;
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
  // Unsubscribe must mirror the subscribe payload exactly.
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

/** Register interest; returns an unsubscribe. */
export function subscribe(sub: Extract<Sub, { type: "l2Book" }>, onData: (data: WireL2Book) => void): () => void;
export function subscribe(sub: Extract<Sub, { type: "trades" }>, onData: (data: WireTrade[]) => void): () => void;
export function subscribe(sub: Sub, onData: Entry["onData"]): () => void {
  const key = keyOf(sub);
  const entry: Entry = { sub, onData, acked: false, ackTimer: undefined };
  registry.set(key, entry);
  send("subscribe", sub);
  armAck(entry);
  return () => {
    registry.delete(key);
    clearTimeout(entry.ackTimer);
    send("unsubscribe", sub);
  };
}

/** Hand `data` to every matching acked entry; a switched-away coin's message finds none. */
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
  if (msg.channel === "l2Book") {
    const data = msg.data as WireL2Book;
    const fast = data.fast === true;
    const delivered = deliver((s) => s.type === "l2Book" && s.coin === data.coin && s.fast === fast, data);
    // "Live" follows data reaching the book, not the socket opening.
    if (delivered) {
      lastDataAt = Date.now();
      if (lastDataAt - openedAt > STABLE_MS) attempt = 0;
      setStatus("live");
    }
  } else if (msg.channel === "trades") {
    const data = msg.data as WireTrade[];
    if (data.length) deliver((s) => s.type === "trades" && s.coin === data[0].coin, data);
  } else if (msg.channel === "subscriptionResponse" && msg.data.method === "subscribe") {
    // The echo is normalised (adds mantissa/fast), so match on our own fields.
    const echoed = msg.data.subscription;
    const entry = registry.get(keyOf({ ...echoed, nSigFigs: echoed.nSigFigs ?? null, fast: echoed.fast === true }));
    if (entry) {
      entry.acked = true;
      clearTimeout(entry.ackTimer);
    }
  }
  // Pongs prove the socket, not the subscription, so they don't feed the watchdog.
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

/** Ping when due, and drop a socket whose snapshots have stopped. */
function tick() {
  if (Date.now() - lastDataAt > STALE_MS) {
    // Half-open socket (e.g. after sleep): close() alone may hang.
    dropSocket();
    scheduleReconnect();
    return;
  }
  if (ws?.readyState === WebSocket.OPEN && Date.now() - lastPingAt >= PING_MS) {
    lastPingAt = Date.now();
    ws.send(JSON.stringify({ method: "ping" }));
  }
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
    lastDataAt = lastPingAt = openedAt = Date.now(); // grace period until the first snapshot
    for (const entry of registry.values()) {
      send("subscribe", entry.sub);
      armAck(entry);
    }
    pingTimer = setInterval(tick, TICK_MS);
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
    // "online" may never fire, so keep retrying on the backoff schedule.
    dropSocket();
    scheduleReconnect();
  });
  window.addEventListener("online", () => {
    // The existing socket was built on the old network; replace it now.
    dropSocket();
    attempt = 0;
    setStatus("reconnecting");
    connect();
  });
  document.addEventListener("visibilitychange", () => {
    // Check an open socket now, and retry a pending reconnect without waiting out its backoff.
    if (document.visibilityState !== "visible") return;
    if (ws?.readyState === WebSocket.OPEN) tick();
    else if (!ws) connect();
  });
  connect();
}
