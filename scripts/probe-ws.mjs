// Reproduces the live-feed findings the app relies on (see README): normalised ACKs, full snapshots,
// the two cadences, pre-ACK stragglers. Run: node scripts/probe-ws.mjs (Node ≥ 22).
const t0 = Date.now();
const log = (...a) => console.log(`[+${String(Date.now() - t0).padStart(5)}ms]`, ...a);
const ws = new WebSocket("wss://api.hyperliquid.xyz/ws");
const payload = (method, nSigFigs, fast) => {
  const subscription = { type: "l2Book", coin: "BTC", ...(fast && { fast }) };
  if (nSigFigs !== null) subscription.nSigFigs = nSigFigs;
  return JSON.stringify({ method, subscription });
};
const step = (d) => Math.abs(Number(d.levels[1][0].px) - Number(d.levels[1][1].px));

let cur = null;
let prev = null;
let acked = null;
let count = 0;
let beforeAck = 0;
let afterAck = 0;
const gaps = [];
let last = 0;

ws.onopen = () => {
  log("open; subscribing BTC full precision with fast:true");
  ws.send(payload("subscribe", cur, true));
  setTimeout(() => ws.send(JSON.stringify({ method: "ping" })), 1000);
  // Flip precision every 900ms to shake out stragglers.
  const order = [4, 3, 2, 5, null];
  let i = 0;
  const flip = setInterval(() => {
    const next = order[i++ % order.length];
    ws.send(payload("unsubscribe", cur, true));
    ws.send(payload("subscribe", next, true));
    prev = cur;
    cur = next;
    if (i === 10) {
      clearInterval(flip);
      setTimeout(() => {
        log(`l2Book msgs=${count}; median gap=${gaps.sort((a, b) => a - b)[gaps.length >> 1]}ms`);
        log(`old-grouping stragglers: before ACK=${beforeAck}, after ACK=${afterAck}`);
        ws.close();
      }, 3000);
    }
  }, 900);
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.channel === "l2Book") {
    count++;
    const now = Date.now();
    if (last) gaps.push(now - last);
    last = now;
    if (count === 1) {
      const [bids, asks] = msg.data.levels;
      log("first snapshot keys:", Object.keys(msg.data), "bids:", bids.length, "asks:", asks.length);
      log("bid0:", JSON.stringify(bids[0]), "ask0:", JSON.stringify(asks[0]));
    }
    // Old grouping if the top step isn't a multiple of the new step (old finer) or ≥ the old step (old
    // coarser). Thin tops can produce false positives, so treat the counts as an upper bound.
    const digits = Math.floor(Math.log10(Number(msg.data.levels[1][0].px))) + 1;
    const stepOf = (n) => (n === null ? 1 : 10 ** (digits - n));
    const s = step(msg.data);
    const stale = prev !== null && (s % stepOf(cur) !== 0 || (stepOf(prev) > stepOf(cur) && s >= stepOf(prev)));
    if (stale && acked !== cur) beforeAck++;
    if (stale && acked === cur) afterAck++;
    return;
  }
  if (msg.channel === "subscriptionResponse") {
    if (msg.data.method === "subscribe") acked = msg.data.subscription.nSigFigs ?? null;
    if (count === 0) log("subscriptionResponse:", JSON.stringify(msg.data));
    return;
  }
  log(msg.channel, JSON.stringify(msg.data ?? "").slice(0, 120));
};
ws.onclose = (e) => log("close", e.code);
