-- CreateTable
CREATE TABLE "redemptions" (
    "id" BIGSERIAL NOT NULL,
    "market_id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "event_index" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "outcome" INTEGER NOT NULL,
    "payout" DECIMAL(40,0) NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "slot" BIGINT NOT NULL,

    CONSTRAINT "redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_redemptions_market_ts" ON "redemptions"("market_id", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "uq_redemptions_sig_event" ON "redemptions"("signature", "event_index");

-- AddForeignKey
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
