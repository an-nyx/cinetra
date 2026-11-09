-- A conservative upper bound on when the current completion state was last saved.
-- Existing show fields, including updatedAt, are left unchanged.
ALTER TABLE "Show" ADD COLUMN "completedMonitorFrom" TIMESTAMP(3);
UPDATE "Show" SET "completedMonitorFrom" = "updatedAt"
WHERE "status" = 'completed' OR ("status" IS NULL AND "completed" = true);
