import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function MarketNotFound() {
  return (
    <Card className="flex flex-col items-center gap-3 p-12 text-center">
      <h1 className="text-[18px] font-700">Market not found</h1>
      <p className="text-[13px] text-muted">
        This market doesn&apos;t exist or hasn&apos;t been indexed yet.
      </p>
      <Button variant="primary" asChild>
        <Link href="/" className="no-underline">
          Back to markets
        </Link>
      </Button>
    </Card>
  );
}
