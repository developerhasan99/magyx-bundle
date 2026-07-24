import prisma from "../db.server";

export type BundleType = "FIXED" | "SLOT_BUILDER" | "MIX_MATCH";
export type BundleStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
export type PricingType = "FIXED_PRICE" | "PERCENT_OFF" | "AMOUNT_OFF";
export type WidgetStyle = "numbered" | "grid" | "minimal";

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

// FIXED bundles only: one alternate purchase option ("2 Pack", "3 Pack", ...)
// under the bundle, each with its own items, gifts, pricing, and free
// shipping — published as one variant on the bundle's Shopify product.
export interface PackageInput {
  // Present when editing an already-saved package; absent for one added in
  // this edit session. Used to update the existing row in place (preserving
  // its `shopifyVariantId`) instead of deleting/recreating it, so a save
  // never orphans an already-published Shopify variant.
  id?: string;
  label: string;
  badgeText?: string | null;
  badgeTone?: string | null;
  position: number;
  pricingType: PricingType;
  pricingValue: number;
  freeShipping: boolean;
  items: BundleItemInput[];
}

export interface BundleInput {
  title: string;
  description?: string;
  type: BundleType;
  status: BundleStatus;
  pricingType: PricingType;
  pricingValue: number;
  // Storefront "what's inside" widget appearance (FIXED bundles only)
  widgetStyle: WidgetStyle;
  widgetHeading: string;
  accentColor: string;
  showPrices: boolean;
  itemSubtextTemplate: string;
  showSubtextOnGifts: boolean;
  // FIXED bundles: waives shipping at checkout when this bundle is bought
  freeShipping: boolean;
  items: BundleItemInput[];
  // FIXED bundles only; empty for MIX_MATCH/SLOT_BUILDER
  packages: PackageInput[];
  rule?: {
    minItems: number;
    maxItems?: number | null;
    discountTiers: DiscountTier[];
    collectionIds: string[];
  } | null;
}

const PACKAGES_INCLUDE = {
  packages: {
    include: { items: { orderBy: { position: "asc" as const } } },
    orderBy: { position: "asc" as const },
  },
};

export function getBundles(shop: string) {
  return prisma.bundle.findMany({
    where: { shop },
    include: { items: { orderBy: { position: "asc" } }, rule: true, ...PACKAGES_INCLUDE },
    orderBy: { updatedAt: "desc" },
  });
}

export function getBundle(shop: string, id: string) {
  return prisma.bundle.findFirst({
    where: { id, shop },
    include: { items: { orderBy: { position: "asc" } }, rule: true, ...PACKAGES_INCLUDE },
  });
}

function packagesCreateData(packages: PackageInput[]) {
  return packages.map((pkg) => ({
    label: pkg.label,
    badgeText: pkg.badgeText,
    badgeTone: pkg.badgeTone,
    position: pkg.position,
    pricingType: pkg.pricingType,
    pricingValue: pkg.pricingValue,
    freeShipping: pkg.freeShipping,
    items: { create: pkg.items },
  }));
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
      widgetStyle: input.widgetStyle,
      widgetHeading: input.widgetHeading,
      accentColor: input.accentColor,
      showPrices: input.showPrices,
      itemSubtextTemplate: input.itemSubtextTemplate,
      showSubtextOnGifts: input.showSubtextOnGifts,
      freeShipping: input.freeShipping,
      items: { create: input.items },
      packages: { create: packagesCreateData(input.packages) },
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
    include: { items: true, rule: true, ...PACKAGES_INCLUDE },
  });
}

export async function updateBundle(shop: string, id: string, input: BundleInput) {
  const existing = await prisma.bundle.findFirst({ where: { id, shop } });
  if (!existing) throw new Response("Bundle not found", { status: 404 });

  return prisma.$transaction(async (tx) => {
    await tx.bundleItem.deleteMany({ where: { bundleId: id } });
    await tx.bundleRule.deleteMany({ where: { bundleId: id } });

    // Packages are upserted by id, not deleted/recreated like items/rule —
    // an existing package's `shopifyVariantId` must survive edits so the
    // publish step can keep updating the same Shopify variant instead of
    // creating a new one and orphaning the old.
    const existingPackages = await tx.bundlePackage.findMany({
      where: { bundleId: id },
      select: { id: true },
    });
    const existingPackageIds = new Set(existingPackages.map((p) => p.id));
    const incomingPackageIds = new Set(
      input.packages.map((p) => p.id).filter((v): v is string => Boolean(v)),
    );
    const removedPackageIds = existingPackages
      .map((p) => p.id)
      .filter((pid) => !incomingPackageIds.has(pid));
    if (removedPackageIds.length > 0) {
      await tx.bundlePackage.deleteMany({ where: { id: { in: removedPackageIds } } });
    }
    for (const pkg of input.packages) {
      const packageData = {
        label: pkg.label,
        badgeText: pkg.badgeText,
        badgeTone: pkg.badgeTone,
        position: pkg.position,
        pricingType: pkg.pricingType,
        pricingValue: pkg.pricingValue,
        freeShipping: pkg.freeShipping,
      };
      if (pkg.id && existingPackageIds.has(pkg.id)) {
        await tx.bundlePackageItem.deleteMany({ where: { packageId: pkg.id } });
        await tx.bundlePackage.update({
          where: { id: pkg.id },
          data: { ...packageData, items: { create: pkg.items } },
        });
      } else {
        await tx.bundlePackage.create({
          data: { ...packageData, bundleId: id, items: { create: pkg.items } },
        });
      }
    }

    return tx.bundle.update({
      where: { id },
      data: {
        title: input.title,
        description: input.description,
        type: input.type,
        status: input.status,
        pricingType: input.pricingType,
        pricingValue: input.pricingValue,
        widgetStyle: input.widgetStyle,
        widgetHeading: input.widgetHeading,
        accentColor: input.accentColor,
        showPrices: input.showPrices,
        itemSubtextTemplate: input.itemSubtextTemplate,
        showSubtextOnGifts: input.showSubtextOnGifts,
        freeShipping: input.freeShipping,
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
      include: { items: true, rule: true, ...PACKAGES_INCLUDE },
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

export async function setPackageVariant(packageId: string, shopifyVariantId: string) {
  return prisma.bundlePackage.update({
    where: { id: packageId },
    data: { shopifyVariantId },
  });
}
