import type { NSigFigs, WireL2Book } from "./types";

/**
 * Module-level WebSocket manager. Owns the single mainnet socket, a subscription registry
 * keyed by (coin, nSigFigs, fast), reconnect with exponential backoff + jitter, resubscribe on
 * every open, a ping that doubles as a liveness watchdog, and offline/online/visibility
 * listeners so the status indicator can never say "live" over a dead connection.
 */
export type Status = "connecting" | "live" | "reconnecting" | "offline";

export interface L2BookSub {
  coin: string;
  nSigFigs: NSigFigs;
  /**
   * The feed has two cadences (verified live): `fast: true` pushes the top 5 levels per side
   * ~2×/s; the default pushes 20 levels per side but only every ~5s. The store merges both.
   */
  fast: boolean;
}

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
  sub: L2BookSub;
  onData: (data: WireL2Book) => void;
  /**
   * l2Book messages do not echo nSigFigs, so after a precision change on the same coin a
   * straggler at the old grouping can arrive. Verified live: stragglers only ever arrive
   * *before* the new subscription's `subscriptionResponse`, never after it. So each entry
   * drops data until its ACK (or a fail-open timeout), which filters stragglers exactly.
   */
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

const keyOf = (sub: L2BookSub) => `${sub.coin}:${sub.nSigFigs ?? "full"}:${sub.fast ? "fast" : "deep"}`;

function setStatus(next: Status) {
  if (next === status) return;
  status = next;
  statusListeners.forEach((l) => l(next));
}

export function onStatus(listener: (s: Status) => void) {
  statusListeners.add(listener);
  listener(status);
}

function send(method: "subscribe" | "unsubscribe", sub: L2BookSub) {
  if (ws?.readyState !== WebSocket.OPEN) return; // onopen resubscribes everything in the registry
  // Unsubscribe must mirror this exact payload, so build it in one place.
  const subscription: Record<string, unknown> = { type: "l2Book", coin: sub.coin };
  if (sub.nSigFigs !== null) subscription.nSigFigs = sub.nSigFigs;
  if (sub.fast) subscription.fast = true;
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
export function subscribe(sub: L2BookSub, onData: Entry["onData"]): () => void {
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

function onMessage(ev: MessageEvent<string>) {
  const msg = JSON.parse(ev.data);
  // Background tabs throttle timers to once a minute, past the server's idle cutoff; the
  // message path is not throttled, so send the ping from here when it is due.
  if (Date.now() - lastPingAt >= PING_MS) ping();
  if (msg.channel === "l2Book") {
    const data = msg.data as WireL2Book;
    // Route by (coin, cadence): a message for a switched-away coin finds no entry and drops here.
    const fast = data.fast === true;
    let delivered = false;
    for (const entry of registry.values()) {
      if (entry.acked && entry.sub.coin === data.coin && entry.sub.fast === fast) {
        entry.onData(data);
        delivered = true;
      }
    }
    // "Live" means snapshots are reaching the book, not merely that the socket opened or that
    // some orphan stream is chatty. Backoff resets here too, so a server that accepts and
    // immediately drops us cannot cause a tight loop.
    if (delivered) {
      lastDataAt = Date.now();
      attempt = 0;
      setStatus("live");
    }
  } else if (msg.channel === "subscriptionResponse" && msg.data.method === "subscribe") {
    // The server normalises the echoed subscription (adds mantissa/fast), so match on our
    // own fields rather than deep-equality.
    const { coin, nSigFigs, fast } = msg.data.subscription;
    const entry = registry.get(keyOf({ coin, nSigFigs: nSigFigs ?? null, fast: fast === true }));
    if (entry) {
      entry.acked = true;
      clearTimeout(entry.ackTimer);
    }
  }
  // "pong" and "error" need no handling. Pongs deliberately don't feed the watchdog: they prove
  // the socket, not the subscription, and a silent subscription must not read as "live".
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

/** Idempotent; call once from the client. */
export function start() {
  if (started) return;
  started = true;
  window.addEventListener("offline", () => {
    // Drop at once so the indicator never lies, but keep retrying on the backoff schedule:
    // navigator.onLine is a hint, not a guarantee, and "online" may never fire.
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
    // Run the watchdog the moment the tab is visible again (a handshake in flight has its own timeout).
    if (document.visibilityState === "visible" && ws?.readyState === WebSocket.OPEN) tick();
  });
  connect();
}
