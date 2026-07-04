import type { Metadata } from "next";
import { Inter, Kalam } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { TopNav } from "@/components/shell/top-nav";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const kalam = Kalam({
  variable: "--font-kalam",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "TXL·Markets — Trade the outcome of every World Cup match",
  description:
    "On-chain prediction market for World Cup matches. Live odds, settled on Solana, resolved by the TxLINE oracle.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${kalam.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="min-h-full">
        <Providers>
          <TopNav />
          <main className="mx-auto w-full max-w-[1120px] px-4 pb-24 pt-6">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
