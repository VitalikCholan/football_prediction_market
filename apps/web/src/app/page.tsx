import { fetchMarkets } from "@/lib/data";
import { MarketsBrowse } from "@/components/market/markets-browse";

/** Markets browse (DESIGN_SPEC 1b). Server component fetches the list. */
export default async function Home() {
  const { markets } = await fetchMarkets();

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-[22px] font-700 tracking-tight">Markets</h1>
        <p className="text-[13px] text-muted">
          Trade the outcome of every World Cup match. Live odds, settled on
          Solana.
        </p>
      </div>
      <MarketsBrowse markets={markets} />
    </div>
  );
}
