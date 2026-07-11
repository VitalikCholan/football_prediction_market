-- C2: extend the shared `markets` table with a market-kind discriminator +
-- nullable/zero-default 1X2 (OneXTwo LMSR) columns. Binary rows keep their
-- exact v0 shape (market_kind defaults to 0); 1X2 rows populate the onex_*
-- columns. Hand-written (no DATABASE_URL at author time) to mirror what
-- `prisma migrate dev --name market_1x2` would emit for schema.prisma.

-- AlterTable: add the discriminator + 1X2 columns.
ALTER TABLE "markets" ADD COLUMN     "market_kind" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "onex_team1_price_bps" INTEGER,
ADD COLUMN     "onex_draw_price_bps" INTEGER,
ADD COLUMN     "onex_team2_price_bps" INTEGER,
ADD COLUMN     "onex_team1_supply" DECIMAL(40,0) NOT NULL DEFAULT 0,
ADD COLUMN     "onex_draw_supply" DECIMAL(40,0) NOT NULL DEFAULT 0,
ADD COLUMN     "onex_team2_supply" DECIMAL(40,0) NOT NULL DEFAULT 0,
ADD COLUMN     "onex_b" DECIMAL(40,0) NOT NULL DEFAULT 0,
ADD COLUMN     "outcome_1x2" TEXT;

-- AlterColumn: the binary reserve/price columns are no longer meaningful for
-- 1X2 rows, so give them defaults (they were previously required on insert via
-- the MarketCreated bootstrap). Existing binary rows are unaffected.
ALTER TABLE "markets" ALTER COLUMN "yes_reserve" SET DEFAULT 0,
ALTER COLUMN "no_reserve" SET DEFAULT 0,
ALTER COLUMN "yes_price_bps" SET DEFAULT 5000;
