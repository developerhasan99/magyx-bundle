-- CreateTable
CREATE TABLE "BundleTier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bundleId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "badgeText" TEXT,
    "badgeTone" TEXT,
    "pricingType" TEXT NOT NULL DEFAULT 'PERCENT_OFF',
    "pricingValue" REAL NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "BundleTier_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
