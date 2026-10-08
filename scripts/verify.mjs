// Drives the widget in real Chromium against live mainnet and reports what it observed.
// Run: pnpm verify (dev server on :3000) or URL=https://… pnpm verify. Writes verify.png.
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

// Re-render discipline at the React level: stand in for the DevTools hook and, per commit, count Row
// fibers that rendered vs. whose props changed (or mounted). Rendering with identical props is the failure.
await page.addInitScript(() => {
  const PerformedWork = 1;
  const shallowEqual = (a, b) => a === b || (a && b && Object.keys(a).every((k) => a[k] === b[k]));
  const stats = { commits: 0, rendered: 0, changed: 0, rows: 0, unnecessary: 0 };
  window.__RENDER_STATS__ = stats;
  const hook = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    onCommitFiberRoot(_, root) {
      let rendered = 0;
      let changed = 0;
      let rows = 0;
      const walk = (fiber) => {
        for (let f = fiber; f; f = f.sibling) {
          const side = f.memoizedProps?.side;
          if ((f.tag === 14 || f.tag === 15) && (side === "ask" || side === "bid")) {
            rows++;
            if (f.flags & PerformedWork) rendered++;
            if (!f.alternate || !shallowEqual(f.memoizedProps, f.alternate.memoizedProps)) changed++;
          }
          if (f.child) walk(f.child);
        }
      };
      walk(root.current.child);
      if (!rows) return;
      stats.commits++;
      stats.rendered += rendered;
      stats.changed += changed;
      stats.rows = rows;
      if (rendered > changed) stats.unnecessary++;
    },
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = new Proxy(hook, { get: (t, k) => (k in t ? t[k] : () => {}) });
});
const consoleErrors = [];
// A reconnect attempt while offline logs a failed-connection error; that is the expected path.
const expected = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/;
page.on("console", (m) => m.type() === "error" && !expected.test(m.text()) && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

const waitForStatus = (s, timeout = 20_000) =>
  page.waitForSelector(`[data-testid="status"][data-status="${s}"]`, { timeout });
/** Resolve once both cadences have landed: the fast top-5 alone would give only 10 level rows. */
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

const changes = await countChanges(5_000);
check("book updates visibly", changes >= 3, `${changes} distinct frames in 5s`);
const flashes = await page.$$eval('.row[class*="flash-"]', (r) => r.length);
check("change flashes are applied", flashes > 0, `${flashes} rows carry a flash class`);
const stats = await page.evaluate(() => window.__RENDER_STATS__);
check(
  "memoized rows render only when their props change",
  stats.commits > 5 && stats.unnecessary === 0,
  `${stats.commits} commits; avg ${(stats.rendered / stats.commits).toFixed(1)} of ${stats.rows} rows rendered per frame`,
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
const rowHeights = await page.$$eval('[data-testid="book"] .row', (rows) =>
  [...new Set(rows.map((r) => r.getBoundingClientRect().height))],
);
check("all book rows share one fixed height", rowHeights.length === 1, `${rowHeights.join(", ")}px`);

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
await page.getByRole("option", { name: "ETH-USD" }).click();
const rightAfter = await page.evaluate(() => ({
  levels: document.querySelectorAll('[data-testid="book"] .row[data-kind="level"]').length,
  loading: document.querySelector('[data-testid="book"]').hasAttribute("data-loading"),
}));
check("switch clears old rows synchronously", rightAfter.levels === 0 && rightAfter.loading, `${rightAfter.levels} level rows, skeleton shown`);
await waitForLevels();
const eth = await prices();
check("ETH book renders after switch", eth.length >= 20 && Math.max(...eth) < Math.min(...initial) / 5, `ETH ≈ ${eth[0]} vs BTC ≈ ${initial[0]}`);

await page.getByRole("tab", { name: "Trades" }).click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="trades"] .row[data-kind="level"]').length >= 10, null, {
  timeout: 20_000,
});
const fills = await page.$$eval('[data-testid="trades"] .row[data-kind="level"]', (rows) =>
  rows.map((r) => ({ side: r.querySelector(".px").className.includes("buy") ? "buy" : r.querySelector(".px").className.includes("sell") ? "sell" : "", time: r.querySelector(".total").textContent })),
);
check(
  "trades tab renders recent fills",
  fills.length >= 10 && fills.every((f) => f.side && /^\d{2}:\d{2}:\d{2}$/.test(f.time)),
  `${fills.length} fills, newest ${fills[0]?.time}`,
);
await page.getByRole("tab", { name: "Orders" }).click();
await waitForLevels();

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

await context.setOffline(true);
await waitForStatus("offline");
check("offline is reported", true);
await context.setOffline(false);
await waitForStatus("live", 30_000);
check("reconnects when back online", true);
const resumed = await countChanges(5_000);
check("data resumes after reconnect", resumed >= 2, `${resumed} distinct frames in 5s`);

await page.screenshot({ path: process.env.SHOT ?? "verify.png" });
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
