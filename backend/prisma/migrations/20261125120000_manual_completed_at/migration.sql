-- Additive only: a nullable column, no backfill. Existing statuses, completion boundaries, legacy protection,
-- saved positions and viewing history are left exactly as they are. Every existing row reads NULL, so the
-- existing rules keep applying to it; only a Completed chosen by hand after this release records a timestamp.
ALTER TABLE "Show" ADD COLUMN "manualCompletedAt" TIMESTAMP(3);
