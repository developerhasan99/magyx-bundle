-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BundlePackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bundleId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "badgeText" TEXT,
    "badgeTone" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "pricingType" TEXT NOT NULL DEFAULT 'PERCENT_OFF',
    "pricingValue" REAL NOT NULL DEFAULT 0,
    "freeShipping" BOOLEAN NOT NULL DEFAULT false,
    "shopifyVariantId" TEXT,
    "poolSource" TEXT NOT NULL DEFAULT 'PRODUCTS',
    "slotCount" INTEGER NOT NULL DEFAULT 2,
    "collectionIds" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "BundlePackage_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BundlePackage" ("badgeText", "badgeTone", "bundleId", "freeShipping", "id", "label", "position", "pricingType", "pricingValue", "shopifyVariantId") SELECT "badgeText", "badgeTone", "bundleId", "freeShipping", "id", "label", "position", "pricingType", "pricingValue", "shopifyVariantId" FROM "BundlePackage";
DROP TABLE "BundlePackage";
ALTER TABLE "new_BundlePackage" RENAME TO "BundlePackage";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
