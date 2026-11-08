-- Additive migration: all existing shows and their manual progress remain intact.
ALTER TABLE "Show" ADD COLUMN "tmdbId" INTEGER;
CREATE UNIQUE INDEX "Show_userId_tmdbId_key" ON "Show"("userId", "tmdbId");
CREATE INDEX "Show_userId_idx" ON "Show"("userId");
CREATE INDEX "Movie_userId_idx" ON "Movie"("userId");

CREATE TABLE "EpisodeWatch" (
    "id" TEXT NOT NULL,
    "showId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "episode" INTEGER NOT NULL,
    "watchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EpisodeWatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EpisodeWatch_showId_season_episode_key" ON "EpisodeWatch"("showId", "season", "episode");
CREATE INDEX "EpisodeWatch_showId_watchedAt_idx" ON "EpisodeWatch"("showId", "watchedAt");
ALTER TABLE "EpisodeWatch" ADD CONSTRAINT "EpisodeWatch_showId_fkey" FOREIGN KEY ("showId") REFERENCES "Show"("id") ON DELETE CASCADE ON UPDATE CASCADE;
