-- Additive only: one new table. No existing table, column or row is changed.
-- An EpisodeUnwatch row marks a single episode as not watched although the show's legacy saved position covers it.
-- CreateTable
CREATE TABLE "EpisodeUnwatch" (
    "id" TEXT NOT NULL,
    "showId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "episode" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EpisodeUnwatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeUnwatch_showId_season_episode_key" ON "EpisodeUnwatch"("showId", "season", "episode");

-- AddForeignKey
ALTER TABLE "EpisodeUnwatch" ADD CONSTRAINT "EpisodeUnwatch_showId_fkey" FOREIGN KEY ("showId") REFERENCES "Show"("id") ON DELETE CASCADE ON UPDATE CASCADE;
