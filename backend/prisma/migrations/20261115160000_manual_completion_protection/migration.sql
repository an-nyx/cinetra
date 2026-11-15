-- Protection metadata only. Never synthesize viewing records or change a personal status.
BEGIN;
ALTER TABLE "Show" ADD COLUMN "statusAutomationProtected" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Show" s SET "statusAutomationProtected" = true
WHERE (s.status = 'completed' OR (s.status IS NULL AND s.completed = true))
AND s."seasonsWatched" = 0 AND s."episodesWatched" = 0
AND NOT EXISTS (SELECT 1 FROM "EpisodeWatch" w WHERE w."showId" = s.id AND w.season > 0 AND w.episode > 0)
AND NOT EXISTS (SELECT 1 FROM "EpisodeUnwatch" u WHERE u."showId" = s.id AND u.season > 0 AND u.episode > 0);
COMMIT;
