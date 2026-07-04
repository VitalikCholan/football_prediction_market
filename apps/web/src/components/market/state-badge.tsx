import type { MarketState } from "@fpm/shared";

/**
 * Maps the on-chain market state to a meaningful badge (DESIGN_SPEC tags):
 * Trading → live, Locked → awaiting proof, Resolved → settled, Open → upcoming.
 */
export function StateBadge({ state }: { state: MarketState }) {
  switch (state) {
    case "Trading":
      return (
        <span className="tag tag-live">
          <span className="dot dot-pulse" aria-hidden /> Live
        </span>
      );
    case "Locked":
      return <span className="tag bg-[#fff5e6] text-[#b7791f]">Awaiting proof</span>;
    case "Resolved":
      return <span className="tag bg-verified-bg text-verified-fg">Resolved</span>;
    case "Closed":
      return <span className="tag bg-skeleton text-muted">Closed</span>;
    case "Open":
    default:
      return <span className="tag bg-skeleton text-muted">Upcoming</span>;
  }
}
