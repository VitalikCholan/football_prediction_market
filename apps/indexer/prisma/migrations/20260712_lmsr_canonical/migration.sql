-- LMSR canonical rename: the binary YES/NO CPMM market is deleted; the 3-way
-- (1X2) LMSR market is now the SOLE market type. Drop the `market_kind`
-- discriminator + all binary columns, and rename the `onex_*` / `outcome_1x2`
-- columns to their canonical names (no prefix). Fresh devnet redeploy — no
-- binary rows with value exist, so this is a straight collapse.
--
-- Hand-written (no DATABASE_URL at author time) to mirror what
-- `prisma migrate dev --name lmsr_canonical` would emit for schema.prisma.

-- ---- markets --------------------------------------------------------------

-- Drop the kind discriminator and the binary-only reserve/supply/price columns.
ALTER TABLE "markets" DROP COLUMN "market_kind";
ALTER TABLE "markets" DROP COLUMN "yes_reserve";
ALTER TABLE "markets" DROP COLUMN "no_reserve";
ALTER TABLE "markets" DROP COLUMN "yes_supply";
ALTER TABLE "markets" DROP COLUMN "no_supply";
ALTER TABLE "markets" DROP COLUMN "yes_price_bps";

-- Collapse the resolved-outcome column: the old binary integer `outcome`
-- (0=NO/1=YES) is gone; the canonical resolved outcome is the 1X2 string.
ALTER TABLE "markets" DROP COLUMN "outcome";
ALTER TABLE "markets" RENAME COLUMN "outcome_1x2" TO "outcome";

-- Rename the 1X2 price/supply/b columns to canonical names.
ALTER TABLE "markets" RENAME COLUMN "onex_team1_price_bps" TO "team1_price_bps";
ALTER TABLE "markets" RENAME COLUMN "onex_draw_price_bps" TO "draw_price_bps";
ALTER TABLE "markets" RENAME COLUMN "onex_team2_price_bps" TO "team2_price_bps";
ALTER TABLE "markets" RENAME COLUMN "onex_team1_supply" TO "team1_supply";
ALTER TABLE "markets" RENAME COLUMN "onex_draw_supply" TO "draw_supply";
ALTER TABLE "markets" RENAME COLUMN "onex_team2_supply" TO "team2_supply";
ALTER TABLE "markets" RENAME COLUMN "onex_b" TO "b";

-- Prices are now always present (3-way row always has 3 softmax prices):
-- make them NOT NULL with the uniform-origin default (floor(10_000/3)).
UPDATE "markets" SET "team1_price_bps" = 3333 WHERE "team1_price_bps" IS NULL;
UPDATE "markets" SET "draw_price_bps"  = 3333 WHERE "draw_price_bps"  IS NULL;
UPDATE "markets" SET "team2_price_bps" = 3333 WHERE "team2_price_bps" IS NULL;
ALTER TABLE "markets" ALTER COLUMN "team1_price_bps" SET NOT NULL,
  ALTER COLUMN "team1_price_bps" SET DEFAULT 3333,
  ALTER COLUMN "draw_price_bps"  SET NOT NULL,
  ALTER COLUMN "draw_price_bps"  SET DEFAULT 3333,
  ALTER COLUMN "team2_price_bps" SET NOT NULL,
  ALTER COLUMN "team2_price_bps" SET DEFAULT 3333;

-- ---- price_points ---------------------------------------------------------

-- Replace the single YES price + reserve columns with the three softmax prices.
ALTER TABLE "price_points" DROP COLUMN "yes_reserve";
ALTER TABLE "price_points" DROP COLUMN "no_reserve";
ALTER TABLE "price_points" RENAME COLUMN "yes_price_bps" TO "team1_price_bps";
ALTER TABLE "price_points" ADD COLUMN "draw_price_bps" INTEGER NOT NULL DEFAULT 3333,
  ADD COLUMN "team2_price_bps" INTEGER NOT NULL DEFAULT 3333;
-- Drop the temporary defaults (writes always supply all three).
ALTER TABLE "price_points" ALTER COLUMN "draw_price_bps" DROP DEFAULT,
  ALTER COLUMN "team2_price_bps" DROP DEFAULT;

-- ---- trades ---------------------------------------------------------------

-- `side` (0=NO/1=YES) becomes `outcome` (0=Team1/1=Draw/2=Team2).
ALTER TABLE "trades" RENAME COLUMN "side" TO "outcome";
