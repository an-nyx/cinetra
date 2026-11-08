ALTER TABLE "Show" ADD COLUMN "tvmazeId" INTEGER;
CREATE UNIQUE INDEX "Show_userId_tvmazeId_key" ON "Show"("userId", "tvmazeId");
