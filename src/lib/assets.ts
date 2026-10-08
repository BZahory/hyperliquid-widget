/** The permissioned asset list; adding one also needs its mark in CoinIcon (a type error until then). */
export const ASSETS = {
  BTC: {
    label: "BTC-USD",
    /** From the `meta` endpoint. */
    szDecimals: 5,
    maxLeverage: 40,
    /** Brand colour: the coin mark and the widget's accent. */
    color: "#f7931a",
  },
  ETH: {
    label: "ETH-USD",
    szDecimals: 4,
    maxLeverage: 25,
    color: "#627eea",
  },
} as const satisfies Record<string, { label: string; szDecimals: number; maxLeverage: number; color: string }>;

export type Coin = keyof typeof ASSETS;

export const COINS = Object.keys(ASSETS) as Coin[];
