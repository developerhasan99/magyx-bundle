-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "pricePerUnitTemplate" TEXT NOT NULL DEFAULT 'That''s only {per_item_price} per item.';
