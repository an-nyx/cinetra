ALTER TABLE "Movie" ADD COLUMN "tmdbId" INTEGER;
ALTER TABLE "Movie" ADD COLUMN "status" TEXT;
ALTER TABLE "Movie" ADD COLUMN "rating" INTEGER;
ALTER TABLE "Movie" ADD COLUMN "notes" TEXT;
CREATE UNIQUE INDEX "Movie_userId_tmdbId_key" ON "Movie"("userId", "tmdbId");
CREATE TABLE "MovieWatch" (
    "id" TEXT NOT NULL,
    "movieId" TEXT NOT NULL,
    "watchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MovieWatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MovieWatch_movieId_watchedAt_idx" ON "MovieWatch"("movieId", "watchedAt");
ALTER TABLE "MovieWatch" ADD CONSTRAINT "MovieWatch_movieId_fkey" FOREIGN KEY ("movieId") REFERENCES "Movie"("id") ON DELETE CASCADE ON UPDATE CASCADE;
