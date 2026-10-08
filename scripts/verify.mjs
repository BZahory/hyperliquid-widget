// Drives the widget in Chromium against live mainnet. Run: pnpm verify, or URL=https://… pnpm verify.
import { chromium } from "playwright";

const url = process.env.URL ?? "http://localhost:3000";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 560, height: 1000 } });
const page = await context.newPage();

// Via the DevTools hook, fail on: a row rendered with unchanged props or an object/function prop, the last
// price rendered unchanged, or two commits in one frame.
await page.addInitScript(() => {
  const PerformedWork = 1;
  const stats = { commits: 0, rendered: 0, rows: 0, fills: 0, needless: 0, nonPrimitive: 0, all: 0, doubled: 0 };
  window.__RENDER_STATS__ = stats;
  let previous = new Set(), lastPrice, lastFrame;
  const hook = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    onCommitFiberRoot(_, root) {
      const current = new Set();
      let rendered = 0;
      const walk = (fiber) => {
        for (let f = fiber; f; f = f.sibling) {
          const props = f.memoizedProps;
          if ((f.tag === 14 || f.tag === 15) && ["ask", "bid", "buy", "sell"].includes(props?.side)) {
            current.add(f);
            if (!previous.has(f) && f.flags & PerformedWork) {
              if (props.side === "buy" || props.side === "sell") stats.fills++;
              else rendered++;
              const before = f.alternate?.memoizedProps;
              if (before && Object.keys(props).every((k) => Object.is(props[k], before[k]))) stats.needless++;
              if (Object.values(props).some((v) => typeof v === "function" || (typeof v === "object" && v !== null))) stats.nonPrimitive++;
            }
          }
          const out = f.child?.memoizedProps;
          if ((f.tag === 0 || f.tag === 15) && out?.["data-testid"] === "last") {
            const before = f.child.alternate?.memoizedProps;
            if (f !== lastPrice && f.flags & PerformedWork && before && ["className", "title", "children"].every((k) => String(out[k]) === String(before[k]))) stats.needless++;
            lastPrice = f;
          }
          if (f.child) walk(f.child);
        }
      };
      walk(root.current.child);
      previous = current;
      // Commits at the same timeline time share a frame.
      stats.all++;
      if (document.timeline.currentTime === lastFrame) stats.doubled++;
      lastFrame = document.timeline.currentTime;
      if (!rendered) return; // Book didn't render in this commit
      stats.commits++;
      stats.rendered += rendered;
      stats.rows = current.size;
    },
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = new Proxy(hook, { get: (t, k) => (k in t ? t[k] : () => {}) });
  window.__FLASHES__ = 0;
  document.addEventListener("animationstart", (e) => e.animationName.startsWith("flash") && window.__FLASHES__++, true);
  // Layout shifts without input in the panel; the hover tooltip overlay is exempt.
  window.__SHIFTS__ = [];
  const inPanel = (node) => {
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return el?.closest?.('[role="tabpanel"]') && !el.closest(".tip");
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput && e.sources.some((s) => inPanel(s.node))) window.__SHIFTS__.push(e.value);
  }).observe({ type: "layout-shift", buffered: true });
});
const consoleErrors = [];
// Reconnecting while offline logs an expected connection error.
const expected = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/;
page.on("console", (m) => m.type() === "error" && !expected.test(m.text()) && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

const waitForStatus = (s, timeout = 20_000) =>
  page.waitForSelector(`[data-testid="status"][data-status="${s}"]`, { timeout });
/** Resolve once both cadences have landed. */
const waitForLevels = () =>
  page.waitForFunction(
    () =>
      !document.querySelector('[data-testid="book"]')?.hasAttribute("data-loading") &&
      document.querySelectorAll('[data-testid="book"] .row[data-kind="level"]').length >= 20,
    null,
    { timeout: 20_000 },
  );
const prices = () =>
  page.$$eval('[data-testid="asks"] .row[data-kind="level"] .px, [data-testid="bids"] .row[data-kind="level"] .px', (els) =>
    els.map((e) => Number(e.textContent.replace(/,/g, ""))),
  );
const cells = () =>
  page.$$eval('[data-testid="asks"] .row, [data-testid="bids"] .row', (rows) =>
    rows.map((r) => r.textContent).join("\n"),
  );
/** Text contrast from rendered pixels: swatch each text's colour and compare it with the background beside it. */
async function contrast() {
  const ask = '[data-testid="asks"] .row:nth-child(3)';
  const bid = '[data-testid="bids"] .row:nth-last-child(3)';
  await page.hover(ask);
  await page.focus(bid);
  const spots = await page.evaluate((sels) =>
    sels.map((sel) => {
      // On the positioned ancestor: React may rewrite a live cell's text.
      const el = document.querySelector(sel);
      const sw = el.offsetParent.appendChild(document.createElement("i"));
      const y = el.offsetTop + el.offsetHeight / 2 - 3;
      sw.style.cssText = `position:absolute;z-index:2;left:${el.offsetLeft}px;top:${y}px;width:6px;height:6px;background:${getComputedStyle(el).color}`;
      el.style.color = "transparent";
      const s = sw.getBoundingClientRect();
      return [s.left + 3, s.top + 3, s.left + 12, s.top + 3];
    }), ['[data-testid="spread"] .text-muted', `${ask} .px`, `${bid} .px`, `${bid} .tip .k`]);
  const png = (await page.screenshot()).toString("base64");
  const ratios = await page.evaluate(async ([png, spots]) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d");
    ctx.drawImage(img, 0, 0);
    const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const lum = (x, y) => {
      const [r, g, b] = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) + 0.05;
    };
    for (const e of document.querySelectorAll('[role="tabpanel"] :is(i, [style^="color"])')) {
      if (e.tagName === "I") e.remove();
      else e.removeAttribute("style");
    }
    return spots.map(([fx, fy, bx, by]) => Math.max(lum(fx, fy), lum(bx, by)) / Math.min(lum(fx, fy), lum(bx, by)));
  }, [png, spots]);
  await page.mouse.move(0, 0);
  return ratios;
}
/** Count how many distinct book states appear over `ms`. */
async function countChanges(ms) {
  let prev = await cells();
  let changes = 0;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await page.waitForTimeout(100);
    const cur = await cells();
    if (cur !== prev) changes++;
    prev = cur;
  }
  return changes;
}

try {
await page.goto(url, { waitUntil: "domcontentloaded" });

await waitForStatus("live");
await waitForLevels();
const initial = await prices();
check("connects and renders levels", initial.length >= 20, `${initial.length} level rows`);

const flashesAt = () => page.evaluate(() => [window.__FLASHES__, window.__RENDER_STATS__.commits]);
const [flashes0, commits0] = await flashesAt();
const changes = await countChanges(5_000);
check("book updates visibly", changes >= 3, `${changes} distinct frames in 5s`);
const last = await page.$eval('[data-testid="last"]', (el) => Number(el.textContent.replace(/[^\d.]/g, "")));
check("spread row shows the last trade price", last > Math.min(...initial) * 0.99 && last < Math.max(...initial) * 1.01, `${last}`);
// A bid's tooltip shows on hover, fits on screen, and carries exact values.
await page.locator('.bids .row[data-kind="level"]').nth(3).hover();
const tip = await page.$eval(".bids .row:hover > .tip", (el) => {
  const r = el.getBoundingClientRect();
  const text = [...el.children].map((c) => c.textContent).join(" ").trim();
  return { shown: getComputedStyle(el).display === "grid", text, inView: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
});
check(
  "row tooltip shows sweep details on hover",
  tip.shown && tip.inView && /^Total \(\w+\) [\d,.]+ Avg price [\d,.]+$/.test(tip.text) && !/0000000|9999999/.test(tip.text),
  tip.text,
);
const titles = await page.$$eval('.bids .row:hover > span, [data-testid="spread"] > span[title]', (els) => els.map((e) => e.title));
check(
  "number cells reveal their full value",
  titles.length === 6 && titles.every((t) => /^[\d,.]+%?$/.test(t)) && !/0000000|9999999/.test(titles.join(" ")),
  titles.join(" · "),
);
await page.mouse.move(0, 0);
// The same tooltip from the keyboard.
await page.getByRole("tabpanel").focus();
await page.keyboard.press("ArrowDown");
const keyTip = await page.evaluate(() => getComputedStyle(document.activeElement.querySelector(".tip")).display);
check("row tooltip shows from the keyboard", keyTip === "grid");
await page.getByRole("tabpanel").focus();
const stats = await page.evaluate(() => window.__RENDER_STATS__);
check(
  "memoized rows and the last price render only on change",
  stats.commits > 5 && stats.needless === 0 && stats.nonPrimitive === 0,
  `${stats.commits} commits; avg ${(stats.rendered / stats.commits).toFixed(1)} of ${stats.rows} rows rendered per frame; ${stats.needless} needless, ${stats.nonPrimitive} with object/function props`,
);

const tabular = await page.evaluate(() => {
  const probe = (text) => {
    const s = document.createElement("span");
    s.className = "px";
    s.textContent = text;
    document.querySelector(".row").appendChild(s);
    const w = s.getBoundingClientRect().width;
    s.remove();
    return w;
  };
  return Math.abs(probe("11111") - probe("00000")) < 0.01;
});
check("tabular numerals (1s and 0s same width)", tabular);
/** Every book row is one height, and the whole widget fits the viewport. */
const fit = () =>
  page.evaluate(() => ({
    heights: [...new Set([...document.querySelectorAll('[data-testid="book"] .row')].map((r) => r.getBoundingClientRect().height))],
    fits: document.querySelector("section.card").getBoundingClientRect().bottom <= innerHeight,
  }));
const tall = await fit();
check("book rows share one height and fit the viewport", tall.heights.length === 1 && tall.fits, `${tall.heights.join(", ")}px rows at 1000px tall`);

// Pick the coarsest step and check every price sits on it.
const visibleTick = () => page.getByRole("combobox", { name: "Price grouping" }).locator("span").first().textContent();
const tickBefore = await visibleTick();
await page.getByRole("combobox", { name: "Price grouping" }).click();
const labels = await page.getByRole("option").allTextContents();
const coarseStep = Number(labels[0].replace(/,/g, ""));
await page.getByRole("option").first().click();
await waitForLevels();
const grouped = await prices();
const offGrid = grouped.filter((p) => Math.abs(p / coarseStep - Math.round(p / coarseStep)) > 1e-9);
check(
  "precision change regroups prices",
  labels.length >= 2 && new Set(labels).size === labels.length && !labels.some((l) => /precision/i.test(l)) && offGrid.length === 0,
  `options [${labels.join(" · ")}]; tick ${tickBefore} → ${await visibleTick()}${offGrid.length ? `; off-grid: ${offGrid.join(" ")}` : ""}`,
);

const market = page.getByRole("combobox", { name: "Market" });
await market.click();
await page.getByTestId("spread").click();
check("outside click closes the menu", (await market.getAttribute("aria-expanded")) === "false");

await market.click();
const flashesBeforeSwitch = await page.evaluate(() => window.__FLASHES__);
await page.getByRole("option", { name: "ETH-USD" }).click();
await page.waitForURL(/\/eth$/);
const rightAfter = await page.evaluate(() => ({
  levels: document.querySelectorAll('[data-testid="book"] .row[data-kind="level"]').length,
  loading: document.querySelector('[data-testid="book"]').hasAttribute("data-loading"),
}));
check("switch navigates to /eth with old rows cleared", rightAfter.levels === 0 && rightAfter.loading, `${rightAfter.levels} level rows, skeleton shown`);
await waitForLevels();
const eth = await prices();
const switchFlashes = (await page.evaluate(() => window.__FLASHES__)) - flashesBeforeSwitch;
check("ETH book renders after switch", eth.length >= 20 && Math.max(...eth) < Math.min(...initial) / 5, `ETH ≈ ${eth[0]} vs BTC ≈ ${initial[0]}`);

const bookHeight = await page.$eval('[role="tabpanel"]', (el) => el.getBoundingClientRect().height);
await page.getByRole("tab", { name: "Trades" }).click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="trades"] .row[data-kind="level"]').length >= 10, null, {
  timeout: 20_000,
});
const fills = await page.$$eval('[data-testid="trades"] .row[data-kind="level"]', (rows) =>
  rows.map((r) => ({
    side: r.querySelector(".px").className.includes("buy") ? "buy" : r.querySelector(".px").className.includes("sell") ? "sell" : "",
    time: r.querySelector(".total").textContent,
    full: r.querySelector(".px").title && r.querySelector(".sz").title,
  })),
);
check(
  "trades tab renders recent fills",
  fills.length >= 10 && fills.every((f) => f.side && f.full && /^\d{2}:\d{2}:\d{2}$/.test(f.time)),
  `${fills.length} fills, newest ${fills[0]?.time}`,
);
const shares = new Set();
for (let i = 0; i < 30; i++) {
  shares.add(await page.$eval('[data-testid="imbalance"] .bar', (el) => el.style.transform));
  await page.waitForTimeout(100);
}
check("imbalance bar moves with the book", shares.size >= 2, `${shares.size} distinct states in 3s`);
// Virtualized: only the rows in view and 5 either side are in the DOM.
const list = '[data-testid="trades"]';
await page.waitForFunction((list) => document.querySelector(list).scrollHeight >= 1.8 * document.querySelector(list).clientHeight, list, { timeout: 60_000 });
const history = await page.$eval(list, (el) => ({
  fills: Math.round(el.scrollHeight / (el.clientHeight / 25)),
  rows: el.querySelectorAll(".row").length,
  height: el.closest('[role="tabpanel"]').getBoundingClientRect().height,
}));
check(
  "trades history scrolls, virtualized, in the book's height",
  history.rows <= 35 && history.rows < history.fills && history.height === bookHeight,
  `${history.rows} rows in the DOM for ${history.fills} fills; panel ${history.height}px, book ${bookHeight}px`,
);
// While scrolling and streaming, rows render only as they enter the view.
const statsBefore = await page.evaluate(() => ({ ...window.__RENDER_STATS__ }));
const listBox = await page.locator(list).boundingBox();
await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
for (let i = 0; i < 12; i++) {
  await page.mouse.wheel(0, 40);
  await page.waitForTimeout(250);
}
const scrolled = await page.evaluate((before) => Object.fromEntries(Object.entries(window.__RENDER_STATS__).map(([k, v]) => [k, v - before[k]])), statsBefore);
check(
  "trade rows render only as they enter the view, one commit a frame",
  scrolled.all > 0 && scrolled.needless === 0 && scrolled.nonPrimitive === 0 && scrolled.doubled === 0,
  `${scrolled.all} commits in 3s, ${scrolled.fills} trade rows rendered; ${scrolled.needless} needless, ${scrolled.nonPrimitive} with object/function props, ${scrolled.doubled} in a frame already committed`,
);
// Scrolled down, fills landing above don't move the row being read.
const anchor = await page.$eval(list, (el) => new Promise((resolve) => {
  const box = el.getBoundingClientRect();
  const row = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2).closest(".row");
  const [y, height, top] = [row.getBoundingClientRect().top, el.scrollHeight, el.scrollTop];
  let frames = 0, moved = 0;
  const tick = () => {
    frames++;
    if (!row.isConnected || Math.abs(row.getBoundingClientRect().top - y) > 0.5) moved++;
    if (el.scrollHeight > height || frames > 1800) resolve({ frames, moved, fills: (el.scrollHeight - height) / (el.clientHeight / 25), scrolled: (el.scrollTop - top) / (el.clientHeight / 25) });
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));
check(
  "new fills keep a scrolled trades view in place",
  anchor.fills > 0 && anchor.moved === 0 && anchor.scrolled === anchor.fills,
  `${anchor.fills} fill(s) landed above; the row read moved in ${anchor.moved} of ${anchor.frames} frames`,
);
const latest = page.getByRole("button", { name: "↑ Latest" });
await latest.click();
const gone = await latest.waitFor({ state: "detached", timeout: 5_000 }).then(() => true, () => false);
check("↑ Latest returns to the newest fills", gone && (await page.$eval(list, (el) => el.scrollTop)) === 0);
// At the end of the history the view stays full as fills land.
const end = await page.$eval(list, (el) => new Promise((resolve) => {
  el.scrollTop = el.scrollHeight;
  const height = el.scrollHeight;
  const box = el.getBoundingClientRect();
  const filled = () => [box.top + 2, box.bottom - 2].every((y) => document.elementFromPoint(box.left + box.width / 2, y)?.closest(".row"));
  let frames = 0;
  const tick = () => {
    if (el.scrollHeight > height || ++frames > 1800) requestAnimationFrame(() => resolve({ landed: el.scrollHeight > height, filled: filled(), rows: el.querySelectorAll(".row").length }));
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));
await page.$eval(list, (el) => (el.scrollTop = 0));
check("the end of the trades history stays filled as fills land", end.landed && end.filled, `${end.rows} rows in the DOM after a fill landed`);
// Tab reaches the list, Page Down scrolls it, and the arrows walk its rows from the first in view.
await page.getByRole("tab", { name: "Trades" }).focus();
await page.keyboard.press("Tab");
const tabbed = await page.evaluate(() => document.activeElement.dataset.testid);
await page.keyboard.press("PageDown");
await page.waitForTimeout(500); // smooth scroll
const paged = await page.$eval(list, (el) => el.scrollTop);
await page.keyboard.press("ArrowDown");
const walked = await page.evaluate(() => {
  const a = document.activeElement;
  return { tag: a.tagName, top: a.closest('[data-testid="trades"]')?.scrollTop, mark: getComputedStyle(a.querySelector(".total"), "::before").content };
});
check(
  "trades list scrolls and walks its rows from the keyboard",
  tabbed === "trades" && paged > 0 && walked.tag === "A" && walked.top >= paged && walked.mark.includes("↗"),
  `Tab → ${tabbed}; Page Down → ${paged}px; ↓ → <${walked.tag.toLowerCase()}> at ${walked.top}px, marked ${walked.mark}`,
);
// Fills with a transaction link to the explorer (zero hashes stay plain); open one and check it.
const links = await page.$$eval(`${list} a.row`, (as) => as.map((a) => `${a.target} ${a.rel} ${a.href}`));
const plain = await page.$$eval(`${list} div.row[data-kind="level"]`, (rows) => rows.length);
const linkShape = /^_blank noopener noreferrer https:\/\/app\.hyperliquid\.xyz\/explorer\/tx\/0x(?!0{64}$)[0-9a-f]{64}$/;
const [tx] = await Promise.all([context.waitForEvent("page"), page.locator(`${list} a.row:focus`).click()]);
const hash = tx.url().split("/").pop();
const shown = await tx
  .waitForFunction((hash) => /Transaction Details/.test(document.body.innerText) && document.body.innerText.includes(hash), hash, { timeout: 30_000 })
  .then(() => true, () => false);
check(
  "a trade opens its transaction on the explorer",
  links.length > 0 && links.every((l) => linkShape.test(l)) && links.some((l) => l.endsWith(tx.url())) && shown,
  `${links.length} links, ${plain} plain rows; opened ${tx.url().replace(hash, `${hash.slice(0, 10)}…`)}: ${shown ? "shows the transaction" : "transaction not shown"}`,
);
await tx.close();
// A focused row stays in place as fills land; Home goes back to live.
await page.mouse.move(0, 0);
await page.locator(list).focus();
await page.keyboard.press("Home");
await page.keyboard.press("ArrowDown");
const held = await page.$eval(list, (el) => new Promise((resolve) => {
  const row = document.activeElement;
  const head = () => +el.firstElementChild.style.getPropertyValue("--head");
  const [y, from] = [row.getBoundingClientRect().top, head()];
  let frames = 0, lost = 0;
  const tick = () => {
    frames++;
    if (document.activeElement !== row || Math.abs(row.getBoundingClientRect().top - y) > 0.5) lost++;
    if (head() - from > 20 || frames > 3600) resolve({ tag: row.tagName, frames, lost, fills: head() - from });
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));
const heldLatest = await latest.isVisible();
await page.keyboard.press("Home");
const released = await page.$eval(list, (el) => new Promise((resolve) => {
  const head = () => +el.firstElementChild.style.getPropertyValue("--head");
  const from = head();
  let frames = 0;
  const tick = () => {
    if (head() > from || ++frames > 3600) requestAnimationFrame(() => resolve({ fills: head() - from, top: el.scrollTop, focus: document.activeElement === el }));
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));
check(
  "a focused trade row stays focused and in place as fills land; Home goes back to live",
  held.tag === "A" && held.fills > 20 && held.lost === 0 && heldLatest && released.fills > 0 && released.top === 0 && released.focus,
  `${held.fills} fills landed above a focused <${held.tag.toLowerCase()}>, lost or moved in ${held.lost} of ${held.frames} frames, ↑ Latest ${heldLatest ? "shown" : "not shown"}; after Home, ${released.fills} more at the top, list focused: ${released.focus}`,
);
const flashesBeforeOrders = await page.evaluate(() => window.__FLASHES__);
await page.getByRole("tab", { name: "Orders" }).click();
await waitForLevels();
const tabFlashes = await page.evaluate(
  (before) => new Promise((r) => requestAnimationFrame(() => r(window.__FLASHES__ - before))),
  flashesBeforeOrders,
);
check("no flashes replayed by a market or tab switch", switchFlashes === 0 && tabFlashes === 0, `${switchFlashes} on the market switch, ${tabFlashes} on the tab switch`);

// End + Enter picks the last option: full precision.
const grouping = page.getByRole("combobox", { name: "Price grouping" });
const tickCoarse = Number((await visibleTick()).replace(/,/g, ""));
await grouping.focus();
await page.keyboard.press("ArrowDown"); // opens
const finest = (await page.getByRole("option").allTextContents()).at(-1);
await page.keyboard.press("End");
await page.keyboard.press("Enter");
await page.waitForFunction(
  (finest) => {
    const el = document.querySelector('[role="combobox"][aria-label="Price grouping"]');
    return el?.querySelector("span")?.textContent === finest && el.getAttribute("aria-expanded") === "false";
  },
  finest,
  { polling: 100, timeout: 10_000 },
);
await waitForLevels();
const tickFull = Number((await visibleTick()).replace(/,/g, ""));
check("keyboard selects full precision", tickFull < tickCoarse, `grouping ${tickCoarse} → ${tickFull}`);

const live = await contrast();
check("text keeps AA contrast on bars, highlights and tooltips", Math.min(...live) >= 4.5, live.map((r) => r.toFixed(2)).join(", "));

await page.getByRole("radio", { checked: true }).focus();
await context.setOffline(true);
await waitForStatus("offline");
check("offline is reported", (await page.locator("header .text-warn").textContent()) === "Offline", "status dot and subtitle");
// Offline, the last book re-derives in the other unit and focus stays put.
await page.keyboard.press("ArrowLeft");
await page.waitForFunction(() => document.querySelector('[role="tabpanel"] > .row')?.textContent.includes("USD"));
await page.waitForTimeout(100); // next frame
const offlineUnit = await page.evaluate(() => ({
  focus: document.activeElement?.getAttribute("role"),
  sz: document.querySelector('[data-testid="bids"] .row .sz').textContent,
}));
check("unit switch works offline", offlineUnit.focus === "radio" && /^[\d,]+$/.test(offlineUnit.sz), `focus on ${offlineUnit.focus}, best bid size ${offlineUnit.sz} USD`);
await page.evaluate(() => Promise.all(document.querySelector(".stale").getAnimations().map((a) => a.finished))); // greyed
const stale = await contrast();
check("greyed panel keeps AA text contrast", Math.min(...stale) >= 4.5, stale.map((r) => r.toFixed(2)).join(", "));
await page.getByRole("radio", { checked: true }).focus();
await page.keyboard.press("ArrowRight");
await context.setOffline(false);
await waitForStatus("live", 30_000);
check("reconnects when back online", true);
const resumed = await countChanges(5_000);
check("data resumes after reconnect", resumed >= 2, `${resumed} distinct frames in 5s`);

// Over the whole run: ~1 row per frame flashes, where any change would flash 7–9.
const [flashes1, commits1] = await flashesAt();
const perFrame = (flashes1 - flashes0) / (commits1 - commits0);
check("changed rows flash, about one per frame", perFrame > 0 && perFrame <= 3, `${perFrame.toFixed(2)} of 24 rows per frame over ${commits1 - commits0} frames`);
await page.screenshot({ path: process.env.SHOT ?? "verify.png" });
const shifts = await page.evaluate(() => window.__SHIFTS__);
check("zero layout shift in the panel", shifts.length === 0, `${shifts.length} shifts without recent input, total ${shifts.reduce((a, b) => a + b, 0).toFixed(5)}`);
// A 768px screen leaves the browser's viewport ~640px tall.
await page.setViewportSize({ width: 1366, height: 640 });
const short = await fit();
check("still fits a 768px screen (640px viewport)", short.heights.length === 1 && short.fits, `${short.heights.join(", ")}px rows`);
check("zero console errors", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 300));
} catch (err) {
  check("run completed", false, String(err).split("\n")[0]);
  await page.screenshot({ path: process.env.SHOT ?? "verify.png" }).catch(() => {});
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
