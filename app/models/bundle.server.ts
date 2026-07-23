import prisma from "../db.server";

export type BundleType = "FIXED" | "SLOT_BUILDER" | "MIX_MATCH";
export type BundleStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
export type PricingType = "FIXED_PRICE" | "PERCENT_OFF" | "AMOUNT_OFF";

export interface DiscountTier {
  quantity: number;
  discount: number;
}

export interface BundleItemInput {
  productId: string;
  variantId?: string | null;
  productTitle: string;
  productImageUrl?: string | null;
  quantity: number;
  isGift: boolean;
  position: number;
}

export interface BundleInput {
  title: string;
  description?: string;
  type: BundleType;
  status: BundleStatus;
  pricingType: PricingType;
  pricingValue: number;
  items: BundleItemInput[];
  rule?: {
    minItems: number;
    maxItems?: number | null;
    discountTiers: DiscountTier[];
    collectionIds: string[];
  } | null;
}

export function getBundles(shop: string) {
  return prisma.bundle.findMany({
    where: { shop },
    include: { items: { orderBy: { position: "asc" } }, rule: true },
    orderBy: { updatedAt: "desc" },
  });
}

export function getBundle(shop: string, id: string) {
  return prisma.bundle.findFirst({
    where: { id, shop },
    include: { items: { orderBy: { position: "asc" } }, rule: true },
  });
}

export async function createBundle(shop: string, input: BundleInput) {
  return prisma.bundle.create({
    data: {
      shop,
      title: input.title,
      description: input.description,
      type: input.type,
      status: input.status,
      pricingType: input.pricingType,
      pricingValue: input.pricingValue,
      items: { create: input.items },
      rule: input.rule
        ? {
            create: {
              minItems: input.rule.minItems,
              maxItems: input.rule.maxItems,
              discountTiers: JSON.stringify(input.rule.discountTiers),
              collectionIds: JSON.stringify(input.rule.collectionIds),
            },
          }
        : undefined,
    },
    include: { items: true, rule: true },
  });
}

export async function updateBundle(shop: string, id: string, input: BundleInput) {
  const existing = await prisma.bundle.findFirst({ where: { id, shop } });
  if (!existing) throw new Response("Bundle not found", { status: 404 });

  return prisma.$transaction(async (tx) => {
    await tx.bundleItem.deleteMany({ where: { bundleId: id } });
    await tx.bundleRule.deleteMany({ where: { bundleId: id } });
    return tx.bundle.update({
      where: { id },
      data: {
        title: input.title,
        description: input.description,
        type: input.type,
        status: input.status,
        pricingType: input.pricingType,
        pricingValue: input.pricingValue,
        items: { create: input.items },
        rule: input.rule
          ? {
              create: {
                minItems: input.rule.minItems,
                maxItems: input.rule.maxItems,
                discountTiers: JSON.stringify(input.rule.discountTiers),
                collectionIds: JSON.stringify(input.rule.collectionIds),
              },
            }
          : undefined,
      },
      include: { items: true, rule: true },
    });
  });
}

export async function deleteBundle(shop: string, id: string) {
  const existing = await prisma.bundle.findFirst({ where: { id, shop } });
  if (!existing) return null;
  return prisma.bundle.delete({ where: { id } });
}

export async function setBundleStatus(shop: string, id: string, status: BundleStatus) {
  const existing = await prisma.bundle.findFirst({ where: { id, shop } });
  if (!existing) throw new Response("Bundle not found", { status: 404 });
  return prisma.bundle.update({ where: { id }, data: { status } });
}

export async function setBundleProduct(id: string, shopifyProductId: string) {
  return prisma.bundle.update({ where: { id }, data: { shopifyProductId } });
}
