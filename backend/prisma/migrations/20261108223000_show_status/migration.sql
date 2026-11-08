-- Keep existing completed flags unchanged; status is optional for legacy records.
ALTER TABLE "Show" ADD COLUMN "status" TEXT;
