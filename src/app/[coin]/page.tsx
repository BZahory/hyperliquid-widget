import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OrderBook } from "@/components/OrderBook";
import { ASSETS, COINS, type Coin } from "@/lib/assets";

type Props = { params: Promise<{ coin: string }> };

/** Only the permissioned symbols exist; any other path is a 404. */
export const dynamicParams = false;

export const generateStaticParams = () => COINS.map((coin) => ({ coin: coin.toLowerCase() }));

const coinOf = async ({ params }: Props) => {
  const coin = (await params).coin.toUpperCase();
  if (!(coin in ASSETS)) notFound();
  return coin as Coin;
};

export const generateMetadata = async (props: Props): Promise<Metadata> => ({ title: `${ASSETS[await coinOf(props)].label} · Hyperliquid Order Book` });

export default async function Page(props: Props) {
  return (
    <main className="flex min-h-svh items-start justify-center px-4 py-3 sm:items-center">
      <OrderBook coin={await coinOf(props)} />
    </main>
  );
}
