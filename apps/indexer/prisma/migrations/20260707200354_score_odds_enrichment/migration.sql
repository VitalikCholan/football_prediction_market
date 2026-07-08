-- AlterTable
ALTER TABLE "markets" ADD COLUMN     "away_score" INTEGER,
ADD COLUMN     "game_state" TEXT,
ADD COLUMN     "home_score" INTEGER,
ADD COLUMN     "match_clock" TEXT,
ADD COLUMN     "odds_away_bps" INTEGER,
ADD COLUMN     "odds_draw_bps" INTEGER,
ADD COLUMN     "odds_home_bps" INTEGER,
ADD COLUMN     "odds_ts" BIGINT,
ADD COLUMN     "status_id" INTEGER;
