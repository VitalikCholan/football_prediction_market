-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "markets" (
    "id" TEXT NOT NULL,
    "fixture_id" BIGINT NOT NULL,
    "config_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "outcome" INTEGER,
    "yes_reserve" DECIMAL(40,0) NOT NULL,
    "no_reserve" DECIMAL(40,0) NOT NULL,
    "yes_supply" DECIMAL(40,0) NOT NULL DEFAULT 0,
    "no_supply" DECIMAL(40,0) NOT NULL DEFAULT 0,
    "yes_price_bps" INTEGER NOT NULL,
    "base_fee_bps" INTEGER,
    "current_fee_bps" INTEGER,
    "total_volume" DECIMAL(40,0) NOT NULL DEFAULT 0,
    "home_team" TEXT,
    "away_team" TEXT,
    "kickoff_ts" TIMESTAMP(3),
    "freeze_ts" TIMESTAMP(3),
    "updated_slot" BIGINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_points" (
    "id" BIGSERIAL NOT NULL,
    "market_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "slot" BIGINT NOT NULL,
    "yes_price_bps" INTEGER NOT NULL,
    "yes_reserve" DECIMAL(40,0) NOT NULL,
    "no_reserve" DECIMAL(40,0) NOT NULL,
    "fee_bps" INTEGER,

    CONSTRAINT "price_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volume_points" (
    "id" BIGSERIAL NOT NULL,
    "market_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "slot" BIGINT NOT NULL,
    "volume" DECIMAL(40,0) NOT NULL,

    CONSTRAINT "volume_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" BIGSERIAL NOT NULL,
    "market_id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "event_index" INTEGER NOT NULL,
    "trader" TEXT NOT NULL,
    "side" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "usdc_in" DECIMAL(40,0) NOT NULL,
    "usdc_out" DECIMAL(40,0) NOT NULL,
    "tokens_amount" DECIMAL(40,0) NOT NULL,
    "price_bps" INTEGER NOT NULL,
    "fee_bps" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "slot" BIGINT NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexer_cursor" (
    "id" BOOLEAN NOT NULL DEFAULT true,
    "last_indexed_signature" TEXT,
    "last_indexed_slot" BIGINT,

    CONSTRAINT "indexer_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "markets_fixture_id_key" ON "markets"("fixture_id");

-- CreateIndex
CREATE INDEX "idx_price_points_market_ts" ON "price_points"("market_id", "ts");

-- CreateIndex
CREATE INDEX "idx_volume_points_market_ts" ON "volume_points"("market_id", "ts");

-- CreateIndex
CREATE INDEX "idx_trades_market_ts" ON "trades"("market_id", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "uq_trades_sig_event" ON "trades"("signature", "event_index");

-- AddForeignKey
ALTER TABLE "price_points" ADD CONSTRAINT "price_points_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volume_points" ADD CONSTRAINT "volume_points_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

