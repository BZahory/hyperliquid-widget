"use client";

import { useEffect } from "react";
import { useStore } from "zustand";
import { boot, setCoin, setPrecision, setQuote, store } from "@/lib/store";
import type { Status } from "@/lib/socket";
import type { Coin, NSigFigs } from "@/lib/types";
import { Book } from "./Book";
import { Select, type Option } from "./Select";

const COIN_OPTIONS: readonly Option<Coin>[] = [
  { value: "BTC", label: "BTC-USD" },
  { value: "ETH", label: "ETH-USD" },
];

const PRECISION_OPTIONS: readonly Option<NSigFigs>[] = [
  { value: null, label: "Full precision" },
  { value: 5, label: "5 significant figures" },
  { value: 4, label: "4 significant figures" },
  { value: 3, label: "3 significant figures" },
  { value: 2, label: "2 significant figures" },
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
        <div className="flex items-end border-b border-line px-4 pt-3">
          <h2 className="border-b-2 border-accent pb-2 text-[15px] font-medium leading-none">Order Book</h2>
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
    <header className="card flex items-center gap-3 px-4 py-3">
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
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${color}`}
        style={status === "live" ? undefined : { animation: "pulse-dot 1.2s ease-in-out infinite" }}
      />
      {STATUS_LABEL[status]}
    </div>
  );
}

function ColumnHeaders() {
  const coin = useStore(store, (s) => s.coin);
  const quote = useStore(store, (s) => s.quote);
  const unit = quote ? "USD" : coin;
  return (
    <div className="row !h-9 text-xs text-muted">
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
  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-sm">
      <Select
        label="Price grouping"
        value={nSigFigs}
        options={PRECISION_OPTIONS}
        onChange={setPrecision}
        display={tick || "—"}
        direction="up"
        className="text-muted"
      />
      <div className="flex gap-3 text-sm" role="group" aria-label="Size unit">
        <UnitButton active={quote} onClick={() => setQuote(true)}>
          USD
        </UnitButton>
        <UnitButton active={!quote} onClick={() => setQuote(false)}>
          {coin}
        </UnitButton>
      </div>
    </div>
  );
}

function UnitButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`cursor-pointer rounded px-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/70 ${
        active ? "font-medium text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
