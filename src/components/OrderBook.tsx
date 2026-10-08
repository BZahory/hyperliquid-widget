"use client";

import { useEffect, type CSSProperties, type KeyboardEvent } from "react";
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
  reconnecting: "Reconnecting",
  offline: "Offline",
};

export function OrderBook() {
  // The app's only effect; boot is idempotent, so StrictMode's double call is harmless.
  useEffect(boot, []);
  const coin = useStore(store, (s) => s.coin);

  return (
    <div className="flex w-full max-w-[440px] flex-col gap-4" style={{ "--asset": ASSETS[coin].color } as CSSProperties}>
      <Header />
      <section className="card">
        <Tabs />
        <Controls />
        <Panel />
      </section>
    </div>
  );
}

function Header() {
  const coin = useStore(store, (s) => s.coin);
  const status = useStore(store, (s) => s.status);
  return (
    <header className="card relative">
      <div className="flex items-center gap-3 px-4 pt-3 pb-4">
        <CoinIcon coin={coin} />
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold leading-tight">{ASSETS[coin].label}</h1>
            <StatusDot status={status} />
          </div>
          <span className="text-sm text-muted">Perpetuals</span>
        </div>
        <span className="ml-auto rounded-md bg-[#1b1e21] px-2.5 py-1.5 text-sm" title="Max leverage">
          {ASSETS[coin].maxLeverage}×
        </span>
        <Select
          label="Market"
          value={coin}
          options={MARKET_OPTIONS}
          onChange={setCoin}
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
      <span aria-hidden="true" className={`block size-2 rounded-full ${color}${status === "live" ? "" : " pulse"}`} />
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
            className="flex-1 cursor-pointer text-center text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
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

function Panel() {
  const tab = useStore(store, (s) => s.tab);
  const coin = useStore(store, (s) => s.coin);
  const quote = useStore(store, (s) => s.quote);
  const stale = useStore(store, (s) => s.status !== "live");
  const unit = quote ? "USD" : coin;
  return (
    <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className={`book${stale ? " stale" : ""}`}>
      <div className="row h-9 text-[13px] text-muted">
        <span>Price</span>
        <span>Size ({unit})</span>
        <span className="total">{tab === "orders" ? `Total (${unit})` : "Time"}</span>
      </div>
      {tab === "orders" ? <Book /> : <Trades />}
    </div>
  );
}

function Controls() {
  const coin = useStore(store, (s) => s.coin);
  const tab = useStore(store, (s) => s.tab);
  const nSigFigs = useStore(store, (s) => s.nSigFigs);
  const quote = useStore(store, (s) => s.quote);
  const tick = useStore(store, (s) => s.book.tick);
  const groupings = useStore(store, (s) => s.book.groupings);
  const live = useStore(store, (s) => s.status === "live");
  // An nSigFigs that isn't offered has full precision's step.
  const value = groupings.some((g) => g.value === nSigFigs) ? nSigFigs : null;
  return (
    <div className="flex items-center justify-between px-5 pt-3 text-sm">
      {tab === "orders" ? (
        <Select
          label="Price grouping"
          value={value}
          options={groupings}
          onChange={setPrecision}
          display={tick || "—"}
        />
      ) : (
        <span />
      )}
      <UnitRadios coin={coin} quote={quote} disabled={!live} />
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

/** Size unit as a radio group: one tab stop, arrows move the choice. Disabled while not live: the
 *  buffers are cleared then, so there is nothing to re-derive in the other unit. */
function UnitRadios({ coin, quote, disabled }: { coin: Coin; quote: boolean; disabled: boolean }) {
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
      disabled={disabled}
      onClick={() => setQuote(value)}
      className={`cursor-pointer rounded px-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:cursor-default disabled:opacity-50 ${
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
