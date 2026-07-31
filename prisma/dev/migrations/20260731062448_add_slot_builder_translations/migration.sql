-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Bundle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "pricingType" TEXT NOT NULL DEFAULT 'PERCENT_OFF',
    "pricingValue" REAL NOT NULL DEFAULT 0,
    "shopifyProductId" TEXT,
    "widgetStyle" TEXT NOT NULL DEFAULT 'numbered',
    "widgetHeading" TEXT NOT NULL DEFAULT 'What''s inside',
    "accentColor" TEXT NOT NULL DEFAULT '#1a1a1a',
    "showPrices" BOOLEAN NOT NULL DEFAULT false,
    "skipCart" BOOLEAN NOT NULL DEFAULT false,
    "itemSubtextTemplate" TEXT NOT NULL DEFAULT '',
    "showSubtextOnGifts" BOOLEAN NOT NULL DEFAULT true,
    "freeShipping" BOOLEAN NOT NULL DEFAULT false,
    "quantityBreakScope" TEXT NOT NULL DEFAULT 'PRODUCTS',
    "translations" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Bundle" ("accentColor", "createdAt", "description", "freeShipping", "id", "itemSubtextTemplate", "pricingType", "pricingValue", "quantityBreakScope", "shop", "shopifyProductId", "showPrices", "showSubtextOnGifts", "skipCart", "status", "title", "type", "updatedAt", "widgetHeading", "widgetStyle") SELECT "accentColor", "createdAt", "description", "freeShipping", "id", "itemSubtextTemplate", "pricingType", "pricingValue", "quantityBreakScope", "shop", "shopifyProductId", "showPrices", "showSubtextOnGifts", "skipCart", "status", "title", "type", "updatedAt", "widgetHeading", "widgetStyle" FROM "Bundle";
DROP TABLE "Bundle";
ALTER TABLE "new_Bundle" RENAME TO "Bundle";
CREATE INDEX "Bundle_shop_status_idx" ON "Bundle"("shop", "status");
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
    "variantFilter" TEXT NOT NULL DEFAULT '',
    "tagFilters" TEXT NOT NULL DEFAULT '[]',
    "translations" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "BundlePackage_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BundlePackage" ("badgeText", "badgeTone", "bundleId", "collectionIds", "freeShipping", "id", "label", "poolSource", "position", "pricingType", "pricingValue", "shopifyVariantId", "slotCount", "tagFilters", "variantFilter") SELECT "badgeText", "badgeTone", "bundleId", "collectionIds", "freeShipping", "id", "label", "poolSource", "position", "pricingType", "pricingValue", "shopifyVariantId", "slotCount", "tagFilters", "variantFilter" FROM "BundlePackage";
DROP TABLE "BundlePackage";
ALTER TABLE "new_BundlePackage" RENAME TO "BundlePackage";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
