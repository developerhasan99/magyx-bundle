-- CreateIndex
-- SQLite, like Postgres, treats NULLs as distinct in a unique index, so any
-- number of bundles may sit unpublished with shopifyProductId = NULL.
CREATE UNIQUE INDEX "Bundle_shopifyProductId_key" ON "Bundle"("shopifyProductId");
