import Link from "next/link";

export default function MarketNotFound() {
  return (
    <div className="scr flex flex-col items-center gap-3 p-12 text-center">
      <h1 className="text-[18px] font-700">Market not found</h1>
      <p className="text-[13px] text-muted">
        This market doesn&apos;t exist or hasn&apos;t been indexed yet.
      </p>
      <Link href="/" className="btn btn-p no-underline">
        Back to markets
      </Link>
    </div>
  );
}
