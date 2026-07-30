import prisma from "../db.server";

export type BundleType = "FIXED" | "SLOT_BUILDER" | "MIX_MATCH" | "QUANTITY_BREAKS";
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
// A free gift bundled with one quantity-break pack size — always $0 at
// checkout, never the tier's own priced product (that's Bundle.items[0]).
export interface TierItemInput {
  productId: string;
  variantId?: string | null;
  productTitle: string;
  productImageUrl?: string | null;
  quantity: number;
  position: number;
}

// QUANTITY_BREAKS bundles only: one selectable pack size, e.g. "1 pack" /
// "2 pack" / "4 pack", each with its own per-unit pricing.
export interface TierInput {
  // Present when editing an already-saved tier; absent for one added in this
  // edit session. Not otherwise significant — tiers carry no external
  // Shopify id, so (unlike packages) they're simply deleted/recreated on save.
  id?: string;
  quantity: number;
  label: string;
  badgeText?: string | null;
  badgeTone?: string | null;
  pricingType: PricingType;
  pricingValue: number;
  isDefault: boolean;
  position: number;
  items: TierItemInput[];
}

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
  // SLOT_BUILDER only: this package's own product pool + slot count — ALL |
  // PRODUCTS scope isn't used here (unlike QUANTITY_BREAKS), just PRODUCTS |
  // COLLECTIONS. Ignored (left at defaults) for FIXED.
  poolSource: string;
  slotCount: number;
  collectionIds: string[];
  // COLLECTIONS-sourced pools only: case-insensitive substring match against
  // each variant's own title (e.g. "50" only keeps "50ml" variants).
  variantFilter: string;
  // Storefront pool-modal filter chips: `label` is the button text customers
  // see, `tag` the exact product tag it matches. Display-only.
  tagFilters: { label: string; tag: string }[];
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
  // QUANTITY_BREAKS only: ALL | PRODUCTS | COLLECTIONS
  quantityBreakScope: string;
  items: BundleItemInput[];
  // FIXED bundles only; empty for MIX_MATCH/SLOT_BUILDER/QUANTITY_BREAKS
  packages: PackageInput[];
  // QUANTITY_BREAKS only; empty for every other type
  tiers: TierInput[];
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

const TIERS_INCLUDE = {
  tiers: {
    include: { items: { orderBy: { position: "asc" as const } } },
    orderBy: { position: "asc" as const },
  },
};

function tiersCreateData(tiers: TierInput[]) {
  return tiers.map((tier) => ({
    quantity: tier.quantity,
    label: tier.label,
    badgeText: tier.badgeText,
    badgeTone: tier.badgeTone,
    pricingType: tier.pricingType,
    pricingValue: tier.pricingValue,
    isDefault: tier.isDefault,
    position: tier.position,
    items: { create: tier.items },
  }));
}

export function getBundles(shop: string) {
  return prisma.bundle.findMany({
    where: { shop },
    include: {
      items: { orderBy: { position: "asc" } },
      rule: true,
      ...PACKAGES_INCLUDE,
      ...TIERS_INCLUDE,
    },
    orderBy: { updatedAt: "desc" },
  });
}

export function getBundle(shop: string, id: string) {
  return prisma.bundle.findFirst({
    where: { id, shop },
    include: {
      items: { orderBy: { position: "asc" } },
      rule: true,
      ...PACKAGES_INCLUDE,
      ...TIERS_INCLUDE,
    },
  });
}

// Used by the storefront app-proxy route to resolve whether the product a
// shopper is viewing has an active quantity-break bundle. Scope (ALL /
// PRODUCTS / COLLECTIONS) can't be filtered in this query — COLLECTIONS
// membership needs a live Admin API call the route makes itself — so this
// just returns every active QUANTITY_BREAKS bundle for the shop (typically a
// small number) for the route to filter by scope.
export function getActiveQuantityBreakBundles(shop: string) {
  return prisma.bundle.findMany({
    where: { shop, type: "QUANTITY_BREAKS", status: "ACTIVE" },
    include: { items: true, rule: true, ...TIERS_INCLUDE },
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
    poolSource: pkg.poolSource,
    slotCount: pkg.slotCount,
    collectionIds: JSON.stringify(pkg.collectionIds),
    variantFilter: pkg.variantFilter,
    tagFilters: JSON.stringify(pkg.tagFilters),
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
      quantityBreakScope: input.quantityBreakScope,
      items: { create: input.items },
      packages: { create: packagesCreateData(input.packages) },
      tiers: { create: tiersCreateData(input.tiers) },
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
    include: { items: true, rule: true, ...PACKAGES_INCLUDE, ...TIERS_INCLUDE },
  });
}

export async function updateBundle(shop: string, id: string, input: BundleInput) {
  const existing = await prisma.bundle.findFirst({ where: { id, shop } });
  if (!existing) throw new Response("Bundle not found", { status: 404 });

  return prisma.$transaction(async (tx) => {
    await tx.bundleItem.deleteMany({ where: { bundleId: id } });
    await tx.bundleRule.deleteMany({ where: { bundleId: id } });
    await tx.bundleTier.deleteMany({ where: { bundleId: id } });

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
        poolSource: pkg.poolSource,
        slotCount: pkg.slotCount,
        collectionIds: JSON.stringify(pkg.collectionIds),
        variantFilter: pkg.variantFilter,
        tagFilters: JSON.stringify(pkg.tagFilters),
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
        quantityBreakScope: input.quantityBreakScope,
        items: { create: input.items },
        tiers: { create: tiersCreateData(input.tiers) },
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
      include: { items: true, rule: true, ...PACKAGES_INCLUDE, ...TIERS_INCLUDE },
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
