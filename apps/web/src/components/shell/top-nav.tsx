"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletChip } from "@/components/wallet/wallet-chip";
import { usd } from "@/lib/format";
import { PORTFOLIO } from "@/lib/fixtures";

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
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-40 border-b border-card-border bg-page/85 backdrop-blur-sm">
      <div className="mx-auto flex h-14 w-full max-w-[1120px] items-center gap-4 px-4">
        <Brand />

        <label className="relative hidden min-w-0 flex-1 items-center md:flex">
          <span className="pointer-events-none absolute left-3 text-muted">
            ⌕
          </span>
          <input
            className="field w-full pl-8"
            placeholder="Search matches, teams, outrights…"
            aria-label="Search markets"
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
          <span className="hidden items-center rounded-full border border-card-border bg-surface px-3 py-1.5 text-[13px] font-600 tnum sm:inline-flex">
            {usd(PORTFOLIO.cash)}
          </span>
          <WalletChip />
        </div>
      </div>
    </header>
  );
}
