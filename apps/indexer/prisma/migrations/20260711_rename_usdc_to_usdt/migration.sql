-- Rename the `trades` collateral columns usdc_in/usdc_out -> usdt_in/usdt_out
-- for consistency with decision D-6 (collateral is USDT). Column rename only —
-- data, types and constraints are preserved. Mirrors the Prisma model-field
-- rename usdcIn/usdcOut -> usdtIn/usdtOut (@map updated to the new columns).
-- Hand-written (no DATABASE_URL at author time) to match what
-- `prisma migrate dev --name rename_usdc_to_usdt` would emit.

ALTER TABLE "trades" RENAME COLUMN "usdc_in" TO "usdt_in";
ALTER TABLE "trades" RENAME COLUMN "usdc_out" TO "usdt_out";
