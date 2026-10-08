"use client";

import { useRouter } from "next/navigation";
import { useLayoutEffect, type CSSProperties, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import { ASSETS, COINS, type Coin } from "@/lib/assets";
import { boot, setCoin, setPrecision, setQuote, setTab, store, type Tab } from "@/lib/store";
import type { Status } from "@/lib/socket";
import { Book } from "./Book";
import { CoinIcon } from "./CoinIcon";
import { Select, type Option } from "./Select";
import { Trades } from "./Trades";

const MARKET_OPTIONS: readonly Option<Coin>[] = COINS.map((coin) => ({ value: coin, label: ASSETS[coin].label }));

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "orders", label: "Orders" },
  { id: "trades", label: "Trades" },
];

const STATUS_LABEL: Record<Status, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};

/** `coin` comes from the route; labels read it, not the store, so a prerendered /eth never shows BTC. */
export function OrderBook({ coin }: { coin: Coin }) {
  // Before paint, so the old coin's book never shows under the new one's header. boot is idempotent.
  useLayoutEffect(() => {
    setCoin(coin);
    boot();
  }, [coin]);

  return (
    <div className="flex w-full max-w-[440px] flex-col gap-4" style={{ "--asset": ASSETS[coin].color } as CSSProperties}>
      <Header coin={coin} />
      <section className="card">
        <Tabs />
        <Panel coin={coin} />
        <Controls coin={coin} />
      </section>
    </div>
  );
}

function Header({ coin }: { coin: Coin }) {
  const router = useRouter();
  const status = useStore(store, (s) => s.status);
  // Spell out a dropped feed; the dot alone is colour-only.
  const down = status === "reconnecting" || status === "offline";
  return (
    <header className="card relative">
      <div className="flex items-center gap-3 px-4 pt-3 pb-4">
        <CoinIcon coin={coin} />
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h1 className="whitespace-nowrap text-xl font-semibold leading-tight">{ASSETS[coin].label}</h1>
            <StatusDot status={status} />
          </div>
          <span className={`text-sm ${down ? "text-warn" : "text-muted"}`}>{down ? STATUS_LABEL[status] : "Perpetuals"}</span>
        </div>
        <span className="ml-auto rounded-md bg-[#1b1e21] px-2.5 py-1.5 text-sm" title="Max leverage">
          {ASSETS[coin].maxLeverage}×
        </span>
        <Select
          label="Market"
          value={coin}
          options={MARKET_OPTIONS}
          onChange={(next) => router.push(`/${next.toLowerCase()}`, { scroll: false })}
          align="right"
          icon={
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          }
        />
      </div>
      {/* Clips the bar to the card's corners without clipping the market menu. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
        <Imbalance />
      </div>
    </header>
  );
}

function StatusDot({ status }: { status: Status }) {
  const color =
    status === "live" ? "bg-bid" : status === "offline" ? "bg-ask" : status === "reconnecting" ? "bg-warn" : "bg-muted";
  return (
    <span role="status" data-testid="status" data-status={status} title={STATUS_LABEL[status]}>
      <span aria-hidden="true" className={`block size-2 rounded-full forced-color-adjust-none ${color}${status === "live" ? "" : " pulse"}`} />
      <span className="sr-only">{STATUS_LABEL[status]}</span>
    </span>
  );
}

function Tabs() {
  const tab = useStore(store, (s) => s.tab);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = TABS[(TABS.findIndex((t) => t.id === tab) + 1) % TABS.length];
    setTab(next.id);
    (e.currentTarget.querySelector(`#tab-${next.id}`) as HTMLElement).focus();
  };
  return (
    <div role="tablist" aria-label="Order book panels" className="flex border-b border-line pt-1" onKeyDown={onKeyDown}>
      {TABS.map(({ id, label }) => {
        const active = id === tab;
        return (
          <button
            key={id}
            id={`tab-${id}`}
            role="tab"
            aria-selected={active}
            aria-controls={`panel-${id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => setTab(id)}
            className="flex-1 cursor-pointer text-center text-[15px] outline-hidden focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            <span className={`inline-block px-6 pb-3 pt-3 ${active ? "-mb-px border-b-2 border-accent text-ink" : "text-muted"}`}>
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Arrow keys walk the rows (not tab stops): a book row shows its tooltip, a trade opens on Enter. */
function walkRows(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(".row[tabindex]")];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  // Start at the first row in view; the trades list renders a few above it.
  const below = e.currentTarget.firstElementChild!.getBoundingClientRect().bottom - 1;
  const next = at < 0 ? rows.findIndex((r) => r.getBoundingClientRect().top >= below) : at + (e.key === "ArrowDown" ? 1 : -1);
  rows[Math.min(Math.max(next, 0), rows.length - 1)]?.focus();
}

function Panel({ coin }: { coin: Coin }) {
  const tab = useStore(store, (s) => s.tab);
  const quote = useStore(store, (s) => s.quote);
  const stale = useStore(store, (s) => s.status !== "live");
  const unit = quote ? "USD" : coin;
  return (
    <div
      role="tabpanel"
      id={`panel-${tab}`}
      aria-labelledby={`tab-${tab}`}
      // The trades list is its own focusable scroller.
      tabIndex={tab === "orders" ? 0 : undefined}
      onKeyDown={walkRows}
      className={`outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70${stale ? " stale" : ""}`}
    >
      <div className="row h-8 text-[13px] text-muted">
        <span>Price</span>
        <span className="sz">Size ({unit})</span>
        <span className="total">{tab === "orders" ? `Total (${unit})` : "Time"}</span>
      </div>
      {tab === "orders" ? <Book /> : <Trades />}
    </div>
  );
}

function Controls({ coin }: { coin: Coin }) {
  const tab = useStore(store, (s) => s.tab);
  const nSigFigs = useStore(store, (s) => s.nSigFigs);
  const quote = useStore(store, (s) => s.quote);
  const tick = useStore(store, (s) => s.book.tick);
  const groupings = useStore(store, (s) => s.book.groupings);
  // An nSigFigs that isn't offered has full precision's step.
  const value = groupings.some((g) => g.value === nSigFigs) ? nSigFigs : null;
  return (
    <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
      {tab === "orders" ? (
        <div className="flex items-center gap-2">
          <span className="text-muted" aria-hidden="true">
            Grouping
          </span>
          <Select label="Price grouping" value={value} options={groupings} onChange={setPrecision} display={tick || "—"} drop="up" />
        </div>
      ) : (
        <span />
      )}
      <UnitRadios coin={coin} quote={quote} />
    </div>
  );
}

/** Bid (green) vs ask (red) share of the book's depth, moving with every book frame. */
function Imbalance() {
  const share = useStore(store, (s) => s.book.bidShare);
  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-0 h-1 bg-ask forced-color-adjust-none" title="Bid vs ask share of the book's 12 levels a side" data-testid="imbalance">
      <div className="bar inset-0 bg-bid" style={{ transform: `scaleX(${share})` }} />
    </div>
  );
}

/** Size unit as a radio group: one tab stop, arrows move the choice; works offline on the kept data. */
function UnitRadios({ coin, quote }: { coin: Coin; quote: boolean }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    setQuote(!quote);
    (e.currentTarget.children[quote ? 1 : 0] as HTMLElement).focus();
  };
  const radio = (active: boolean, label: string, value: boolean) => (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      tabIndex={active ? 0 : -1}
      onClick={() => setQuote(value)}
      className={`hit cursor-pointer rounded px-1 outline-hidden focus-visible:ring-2 focus-visible:ring-accent/70 ${
        active ? "font-medium text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex gap-3 text-sm" role="radiogroup" aria-label="Size unit" onKeyDown={onKeyDown}>
      {radio(quote, "USD", true)}
      {radio(!quote, coin, false)}
    </div>
  );
}
