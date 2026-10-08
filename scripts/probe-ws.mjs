// Re-checks the live-feed findings in the README. Run: node scripts/probe-ws.mjs (Node ≥ 22).
const t0 = Date.now();
const log = (...a) => console.log(`[+${String(Date.now() - t0).padStart(5)}ms]`, ...a);
const ws = new WebSocket("wss://api.hyperliquid.xyz/ws");
const payload = (method, nSigFigs, fast) => {
  const subscription = { type: "l2Book", coin: "BTC", ...(fast && { fast }) };
  if (nSigFigs !== null) subscription.nSigFigs = nSigFigs;
  return JSON.stringify({ method, subscription });
};
/** The store's switch: unsubscribe both cadences, then subscribe both at the new grouping. */
const both = (method, nSigFigs) => [true, false].forEach((fast) => ws.send(payload(method, nSigFigs, fast)));
/** Exponent of the coarsest power of ten every price is a multiple of. */
const grid = (d) => Math.min(...d.levels.flat().map((l) => { let k = 0; for (let p = Number(l.px); p % 10 === 0 && p; p /= 10) k++; return k; }));
/** Mirrors fitsGrouping in src/lib/derive.ts, for BTC prices. */
const fits = (d, n) => (d.spread === undefined) === (n === null) && (n === null || grid(d) === Math.floor(Math.log10(Number(d.levels[0][0].px))) + 1 - n);

let cur = null;
let count = 0;
const acked = { fast: false, deep: false };
const stragglers = { fast: [0, 0], deep: [0, 0] }; // [before ACK, after ACK]
const gaps = [];
let last = 0;

ws.onopen = () => {
  log("open; subscribing BTC full precision, fast and deep");
  both("subscribe", cur);
  setTimeout(() => ws.send(JSON.stringify({ method: "ping" })), 1000);
  // Flip precision at random 300-1500ms intervals to shake out stragglers.
  const order = [4, 3, 2, 5, null];
  let i = 0;
  const flip = () => {
    both("unsubscribe", cur);
    cur = order[i++ % order.length];
    acked.fast = acked.deep = false;
    both("subscribe", cur);
    if (i < 30) return setTimeout(flip, 300 + Math.random() * 1200);
    setTimeout(() => {
      log(`l2Book msgs=${count}; median fast gap=${gaps.sort((a, b) => a - b)[gaps.length >> 1]}ms`);
      for (const k of ["fast", "deep"]) log(`${k} old-grouping stragglers: before ACK=${stragglers[k][0]}, after ACK=${stragglers[k][1]}`);
      ws.close();
    }, 3000);
  };
  setTimeout(flip, 1500);
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.channel === "l2Book") {
    count++;
    const k = msg.data.fast ? "fast" : "deep";
    if (k === "fast") {
      if (last) gaps.push(Date.now() - last);
      last = Date.now();
    }
    if (count === 1) {
      const [bids, asks] = msg.data.levels;
      log("first snapshot keys:", Object.keys(msg.data), "bids:", bids.length, "asks:", asks.length);
      log("bid0:", JSON.stringify(bids[0]), "ask0:", JSON.stringify(asks[0]));
    }
    if (!fits(msg.data, cur)) stragglers[k][acked[k] ? 1 : 0]++;
    return;
  }
  if (msg.channel === "subscriptionResponse") {
    const sub = msg.data.subscription;
    if (msg.data.method === "subscribe" && (sub.nSigFigs ?? null) === cur) acked[sub.fast ? "fast" : "deep"] = true;
    if (count === 0) log("subscriptionResponse:", JSON.stringify(msg.data));
    return;
  }
  log(msg.channel, JSON.stringify(msg.data ?? "").slice(0, 120));
};
ws.onclose = (e) => log("close", e.code);
