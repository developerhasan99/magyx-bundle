-- CreateTable
CREATE TABLE "BundlePackage" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "badgeText" TEXT,
    "badgeTone" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "pricingType" TEXT NOT NULL DEFAULT 'PERCENT_OFF',
    "pricingValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "freeShipping" BOOLEAN NOT NULL DEFAULT false,
    "shopifyVariantId" TEXT,

    CONSTRAINT "BundlePackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundlePackageItem" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "productTitle" TEXT NOT NULL,
    "productImageUrl" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "isGift" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BundlePackageItem_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "BundlePackage" ADD CONSTRAINT "BundlePackage_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundlePackageItem" ADD CONSTRAINT "BundlePackageItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "BundlePackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: give every existing FIXED bundle a default package mirroring its
-- current flat items/pricing/freeShipping, so bundles saved before packages
-- existed keep working unchanged once the app reads packages for FIXED type.
INSERT INTO "BundlePackage" ("id", "bundleId", "label", "position", "pricingType", "pricingValue", "freeShipping")
SELECT
  md5(random()::text || clock_timestamp()::text || "id"),
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
  md5(random()::text || clock_timestamp()::text || bi."id"),
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
