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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Bundle" ("createdAt", "description", "id", "pricingType", "pricingValue", "shop", "shopifyProductId", "status", "title", "type", "updatedAt") SELECT "createdAt", "description", "id", "pricingType", "pricingValue", "shop", "shopifyProductId", "status", "title", "type", "updatedAt" FROM "Bundle";
DROP TABLE "Bundle";
ALTER TABLE "new_Bundle" RENAME TO "Bundle";
CREATE INDEX "Bundle_shop_status_idx" ON "Bundle"("shop", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
