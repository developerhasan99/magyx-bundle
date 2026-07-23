-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "widgetStyle" TEXT NOT NULL DEFAULT 'numbered';
ALTER TABLE "Bundle" ADD COLUMN     "widgetHeading" TEXT NOT NULL DEFAULT 'What''s inside';
ALTER TABLE "Bundle" ADD COLUMN     "accentColor" TEXT NOT NULL DEFAULT '#1a1a1a';
ALTER TABLE "Bundle" ADD COLUMN     "showPrices" BOOLEAN NOT NULL DEFAULT false;
