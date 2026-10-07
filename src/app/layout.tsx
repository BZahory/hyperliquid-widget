import type { Metadata } from "next";
import { Geist } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const geist = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

const title = "Hyperliquid Order Book";
const description = "Live BTC and ETH perpetual order books from Hyperliquid mainnet.";

/** The icon and Open Graph image come from the icon.svg and opengraph-image.png file conventions. */
export const metadata: Metadata = {
  metadataBase: new URL("https://hyperliquid-widget.vercel.app"),
  title,
  description,
  openGraph: { title, description },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} antialiased`}>
      <body>{children}</body>
    </html>
  );
}
