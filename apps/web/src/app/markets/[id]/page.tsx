import { notFound } from "next/navigation";
import { fetchMarket, fetchHistory } from "@/lib/data";
import { MarketDetail } from "@/components/market/market-detail";

/** Match detail (DESIGN_SPEC 1c / 1d / 1g). Server shell + client islands. */
export default async function MarketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const market = await fetchMarket(id);
  if (!market) notFound();

  const history = await fetchHistory(id);

  return <MarketDetail market={market} points={history.points} />;
}
