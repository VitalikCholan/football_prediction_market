import type { MarketState } from "@fpm/shared";
import { Badge } from "@/components/ui/badge";

/**
 * Maps the on-chain market state to a meaningful badge (DESIGN_SPEC tags):
 * Trading → live, Locked → awaiting proof, Resolved → settled, Open → upcoming.
 */
export function StateBadge({ state }: { state: MarketState }) {
  switch (state) {
    case "Trading":
      return (
        <Badge variant="live">
          <span className="dot dot-pulse" aria-hidden /> Live
        </Badge>
      );
    case "Locked":
      return <Badge variant="warning">Awaiting proof</Badge>;
    case "Resolved":
      return <Badge variant="resolved">Resolved</Badge>;
    case "Closed":
      return <Badge variant="muted">Closed</Badge>;
    case "Open":
    default:
      return <Badge variant="muted">Upcoming</Badge>;
  }
}
