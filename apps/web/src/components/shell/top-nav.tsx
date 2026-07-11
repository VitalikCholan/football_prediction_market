"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { WalletChip } from "@/components/wallet/wallet-chip";
import { useAccountAddress } from "@/components/wallet/use-account";
import { useUsdtBalance } from "@/lib/use-live";
import { useSearch } from "@/lib/search";
import { usd } from "@/lib/format";

const NAV = [
  { href: "/", label: "Markets" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/positions", label: "Activity" },
];

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-1.5 no-underline">
      <span className="text-[15px] text-ink" aria-hidden>
        ◆
      </span>
      <span className="text-[15px] font-700 tracking-tight text-ink">
        TXL<span className="text-muted">·</span>Markets
      </span>
    </Link>
  );
}

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { query, setQuery } = useSearch();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  // Balance pill (1b): REAL USDT balance for the connected wallet.
  const address = useAccountAddress();
  const { balanceBase } = useUsdtBalance(address);
  const pill = address
    ? balanceBase === null
      ? "…"
      : usd(Number(balanceBase) / 1_000_000)
    : null;

  return (
    <header className="sticky top-0 z-40 border-b border-card-border bg-page/85 backdrop-blur-sm">
      <div className="mx-auto flex h-14 w-full max-w-[1120px] items-center gap-4 px-4">
        <Brand />

        <label className="relative hidden min-w-0 flex-1 items-center md:flex">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
          <input
            className="field w-full"
            style={{ paddingLeft: 34 }}
            placeholder="Search matches, teams, outrights…"
            aria-label="Search markets"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // Search only filters the markets grid — hop to it if typing elsewhere.
              if (pathname !== "/") router.push("/");
            }}
          />
        </label>

        <nav className="hidden items-center gap-1 lg:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`rounded-lg px-3 py-1.5 text-[13px] font-500 no-underline transition-colors ${
                isActive(n.href)
                  ? "bg-ink text-surface"
                  : "text-ink hover:bg-black/[0.04]"
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {pill !== null ? (
            <span
              className="hidden items-center rounded-full border border-card-border bg-surface px-3 py-1.5 text-[13px] font-600 tnum sm:inline-flex"
              title="USDT balance (devnet)"
            >
              {pill}
            </span>
          ) : null}
          <WalletChip />
        </div>
      </div>
    </header>
  );
}
