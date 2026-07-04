import { WalletGate } from "@/components/wallet/wallet-gate";
import { PositionsView } from "@/components/position/positions-view";

/** Portfolio / positions (DESIGN_SPEC 1e). Wallet-gated. */
export default function PositionsPage() {
  return (
    <div>
      <div className="mb-5">
        <h1 className="text-[22px] font-700 tracking-tight">Portfolio</h1>
        <p className="text-[13px] text-muted">
          Your open positions, history, and claims.
        </p>
      </div>
      <WalletGate
        title="Connect to see your portfolio"
        hint="Connect a Solana wallet to view your positions and P/L."
      >
        <PositionsView />
      </WalletGate>
    </div>
  );
}
