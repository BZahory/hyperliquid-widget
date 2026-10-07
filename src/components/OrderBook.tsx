"use client";

import { useEffect, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import { boot, setCoin, setPrecision, setQuote, store } from "@/lib/store";
import type { Status } from "@/lib/socket";
import type { Coin } from "@/lib/types";
import { Book } from "./Book";
import { Select, type Option } from "./Select";

const COIN_OPTIONS: readonly Option<Coin>[] = [
  { value: "BTC", label: "BTC-USD" },
  { value: "ETH", label: "ETH-USD" },
];

const STATUS_LABEL: Record<Status, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

export function OrderBook() {
  // The only effect in the app: boot the data layer once the widget is on screen.
  // `boot` is idempotent, so StrictMode's double invocation changes nothing.
  useEffect(boot, []);

  return (
    <div className="flex w-full max-w-[440px] flex-col gap-4">
      <Header />
      <section className="card pb-1">
        <div className="flex items-end border-b border-line px-4 pt-2.5">
          <h1 className="border-b-2 border-accent pb-2 text-[15px] font-medium leading-none">Order Book</h1>
        </div>
        <ColumnHeaders />
        <Book />
        <Footer />
      </section>
    </div>
  );
}

function Header() {
  const coin = useStore(store, (s) => s.coin);
  const status = useStore(store, (s) => s.status);
  return (
    <header className="card flex items-center gap-3 px-4 py-2">
      <span
        aria-hidden="true"
        className={`flex size-10 items-center justify-center rounded-full text-lg font-bold text-[#0f1113] ${
          coin === "BTC" ? "bg-accent" : "bg-[#8ea0ff]"
        }`}
      >
        {coin === "BTC" ? "₿" : "Ξ"}
      </span>
      <div className="flex flex-col gap-0.5">
        <Select
          label="Market"
          value={coin}
          options={COIN_OPTIONS}
          onChange={setCoin}
          className="text-xl font-semibold leading-tight"
        />
        <span className="text-sm text-muted">Perpetuals</span>
      </div>
      <StatusDot status={status} />
    </header>
  );
}

function StatusDot({ status }: { status: Status }) {
  const color =
    status === "live" ? "bg-bid" : status === "offline" ? "bg-ask" : status === "reconnecting" ? "bg-warn" : "bg-muted";
  return (
    <div
      className="ml-auto flex items-center gap-2 rounded-md bg-[#1b1e21] px-2.5 py-1.5 text-xs text-muted"
      role="status"
      data-testid="status"
      data-status={status}
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${color}${status === "live" ? "" : " pulse"}`} />
      {STATUS_LABEL[status]}
    </div>
  );
}

function ColumnHeaders() {
  const coin = useStore(store, (s) => s.coin);
  const quote = useStore(store, (s) => s.quote);
  const unit = quote ? "USD" : coin;
  return (
    <div className="row h-7 text-xs text-muted">
      <span>Price</span>
      <span>Size ({unit})</span>
      <span className="total">Total ({unit})</span>
    </div>
  );
}

function Footer() {
  const coin = useStore(store, (s) => s.coin);
  const nSigFigs = useStore(store, (s) => s.nSigFigs);
  const quote = useStore(store, (s) => s.quote);
  const tick = useStore(store, (s) => s.book.tick);
  const groupings = useStore(store, (s) => s.book.groupings);
  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-2 text-sm">
      <Select
        label="Price grouping"
        value={nSigFigs}
        options={groupings}
        onChange={setPrecision}
        display={tick || "—"}
        direction="up"
        className="text-muted"
      />
      <UnitRadios coin={coin} quote={quote} />
    </div>
  );
}

/** Size unit as a radio group: one tab stop, arrows move the choice. */
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
      className={`cursor-pointer rounded px-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/70 ${
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
