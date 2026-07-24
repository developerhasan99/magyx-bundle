-- CreateTable
CREATE TABLE "BundleTierItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "productTitle" TEXT NOT NULL,
    "productImageUrl" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "BundleTierItem_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "BundleTier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
