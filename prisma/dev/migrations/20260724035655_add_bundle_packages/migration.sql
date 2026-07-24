-- CreateTable
CREATE TABLE "BundlePackage" (
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
    CONSTRAINT "BundlePackage_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BundlePackageItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "productTitle" TEXT NOT NULL,
    "productImageUrl" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "isGift" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "BundlePackageItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "BundlePackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Backfill: give every existing FIXED bundle a default package mirroring its
-- current flat items/pricing/freeShipping, so bundles saved before packages
-- existed keep working unchanged once the app reads packages for FIXED type.
INSERT INTO "BundlePackage" ("id", "bundleId", "label", "position", "pricingType", "pricingValue", "freeShipping")
SELECT
  lower(hex(randomblob(16))),
  "id",
  'Default',
  0,
  "pricingType",
  "pricingValue",
  "freeShipping"
FROM "Bundle"
WHERE "type" = 'FIXED';

INSERT INTO "BundlePackageItem" ("id", "packageId", "productId", "variantId", "productTitle", "productImageUrl", "quantity", "isGift", "position")
SELECT
  lower(hex(randomblob(16))),
  bp."id",
  bi."productId",
  bi."variantId",
  bi."productTitle",
  bi."productImageUrl",
  bi."quantity",
  bi."isGift",
  bi."position"
FROM "BundleItem" bi
JOIN "Bundle" b ON b."id" = bi."bundleId"
JOIN "BundlePackage" bp ON bp."bundleId" = b."id"
WHERE b."type" = 'FIXED';
