// Drives the widget in real Chromium against live mainnet data and reports what it observed.
// Run: pnpm verify                       (dev server on http://localhost:3000)
//      URL=https://<deploy>.vercel.app pnpm verify
// Writes verify.png next to the repo for a visual check.
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

// Re-render discipline, measured at the React level: stand in for the React DevTools hook and,
// on every commit, count memoized Row fibers that did work vs. Row fibers whose props changed
// (or just mounted). Cumulative totals and the shared max legitimately touch most rows on a
// tick; what must never happen is a row rendering with identical props.
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
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

const status = () => page.getAttribute('[data-testid="status"]', "data-status");
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

await page.goto(url, { waitUntil: "domcontentloaded" });

// 1. Connects and renders real levels.
await waitForStatus("live");
await waitForLevels();
check("connects and renders levels", (await prices()).length >= 20, `${(await prices()).length} level rows`);

// 2. Visibly updates from the feed.
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

// 3. Layout stability: digits are tabular so values never move pixels.
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

// 4. Precision dropdown resubscribes and visibly regroups prices.
const visibleTick = () => page.getByRole("combobox", { name: "Price grouping" }).locator("span").first().textContent();
const tickBefore = await visibleTick();
await page.getByRole("combobox", { name: "Price grouping" }).click();
await page.getByRole("option", { name: "3 significant figures" }).click();
await waitForLevels();
const grouped = await prices();
// Every price must be a multiple of its own 3-significant-figure step (sides may straddle a power of ten).
const onGrid = (p) => {
  const step = 10 ** (Math.floor(Math.log10(p)) - 2);
  return Math.abs(p / step - Math.round(p / step)) < 1e-9;
};
const offGrid = grouped.filter((p) => !onGrid(p));
check(
  "precision change regroups prices",
  offGrid.length === 0,
  `tick ${tickBefore} → ${await visibleTick()}${offGrid.length ? `; off-grid: ${offGrid.join(" ")}` : ""}`,
);

// 5. Symbol switch shows no stale rows.
await page.getByRole("combobox", { name: "Market" }).click();
await page.getByRole("option", { name: "ETH-USD" }).click();
const rightAfter = await prices();
check("switch clears old rows synchronously", rightAfter.every((p) => p < 10_000), `${rightAfter.length} level rows right after click`);
await waitForLevels();
const eth = await prices();
check("ETH book renders after switch", eth.length >= 10 && eth.every((p) => p < 10_000), `best ask region ≈ ${eth[eth.length - 1]}`);

// 6. Keyboard: the dropdowns work without a mouse.
const grouping = page.getByRole("combobox", { name: "Price grouping" });
await grouping.focus();
await page.keyboard.press("ArrowDown"); // opens
await page.keyboard.press("Home");
await page.keyboard.press("Enter"); // "Full precision"
await page.waitForFunction(
  () => {
    const el = document.querySelector('[role="combobox"][aria-label="Price grouping"]');
    return el?.textContent.includes("Full precision") && el.getAttribute("aria-expanded") === "false";
  },
  null,
  { polling: 100, timeout: 10_000 },
);
await waitForLevels();
const fine = await prices();
const gaps = fine.slice(1).map((p, i) => Math.abs(p - fine[i])).filter((g) => g > 0);
check("keyboard selects full precision", Math.min(...gaps) < 1, `selected label updated; min gap ${Math.min(...gaps).toFixed(2)}`);

// 7. Offline → status changes → online → data resumes without reload.
await context.setOffline(true);
await waitForStatus("offline");
check("offline is reported", (await status()) === "offline");
await context.setOffline(false);
await waitForStatus("live", 30_000);
check("reconnects when back online", (await status()) === "live");
const resumed = await countChanges(5_000);
check("data resumes after reconnect", resumed >= 2, `${resumed} distinct frames in 5s`);

await page.screenshot({ path: process.env.SHOT ?? "verify.png" });
check("zero console errors", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 300));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
