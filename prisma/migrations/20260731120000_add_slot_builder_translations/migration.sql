-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "translations" TEXT NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "BundlePackage" ADD COLUMN     "translations" TEXT NOT NULL DEFAULT '{}';
