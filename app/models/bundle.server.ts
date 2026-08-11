import prisma from "../db.server";
import {
  parseTranslations,
  type PackageTranslations,
  type SlotBuilderTranslations,
} from "../utils/slot-builder-text";

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
  // Optional override for the computed compare-at price. null = use the
  // computed one (components summed / pool average x slots).
  compareAtPrice: number | null;
  freeShipping: boolean;
  // SLOT_BUILDER only: the package the storefront widget opens on. All false
  // (every bundle predating the flag) means the first one.
  isDefault: boolean;
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
  // SLOT_BUILDER only: this package's label/badge/chip copy per storefront
  // locale. The fields above stay the primary-locale copy and the fallback.
  translations: PackageTranslations;
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
  // SLOT_BUILDER only: the supporting line under the widget's progress text
  widgetDescription: string;
  // SLOT_BUILDER only: shortcode template for the price line in a pack tab
  packPriceTemplate: string;
  // SLOT_BUILDER only: shortcode template for the per-item line under the
  // price. Empty hides the line entirely.
  pricePerUnitTemplate: string;
  accentColor: string;
  showPrices: boolean;
  // SLOT_BUILDER only: skip the cart and go straight to checkout after adding
  skipCart: boolean;
  // SLOT_BUILDER only: submit as soon as the last slot is filled, without
  // waiting for the customer to press the button. Requires skipCart.
  autoCheckout: boolean;
  // SLOT_BUILDER only: gift cards above the progress line, not under the slots
  giftsBeforeSlots: boolean;
  // SLOT_BUILDER only: GLOBAL | PER_PACKAGE. Authoring-only — GLOBAL means
  // the caller has already copied one pool onto every package, so the rows
  // written here look identical either way.
  poolMode: string;
  itemSubtextTemplate: string;
  showSubtextOnGifts: boolean;
  // FIXED bundles: waives shipping at checkout when this bundle is bought
  freeShipping: boolean;
  // QUANTITY_BREAKS only: ALL | PRODUCTS | COLLECTIONS
  quantityBreakScope: string;
  // SLOT_BUILDER only: storefront widget copy per locale, keyed by the string
  // keys in app/utils/slot-builder-text.ts (plus the reserved "heading" key,
  // whose primary-locale copy is `widgetHeading` above).
  translations: SlotBuilderTranslations;
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
    compareAtPrice: pkg.compareAtPrice,
    freeShipping: pkg.freeShipping,
    isDefault: pkg.isDefault,
    poolSource: pkg.poolSource,
    slotCount: pkg.slotCount,
    collectionIds: JSON.stringify(pkg.collectionIds),
    variantFilter: pkg.variantFilter,
    tagFilters: JSON.stringify(pkg.tagFilters),
    translations: JSON.stringify(pkg.translations ?? {}),
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
      widgetDescription: input.widgetDescription,
      packPriceTemplate: input.packPriceTemplate,
      pricePerUnitTemplate: input.pricePerUnitTemplate,
      accentColor: input.accentColor,
      showPrices: input.showPrices,
      skipCart: input.skipCart,
      autoCheckout: input.autoCheckout,
      giftsBeforeSlots: input.giftsBeforeSlots,
      poolMode: input.poolMode,
      itemSubtextTemplate: input.itemSubtextTemplate,
      showSubtextOnGifts: input.showSubtextOnGifts,
      freeShipping: input.freeShipping,
      quantityBreakScope: input.quantityBreakScope,
      translations: JSON.stringify(input.translations ?? {}),
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
        compareAtPrice: pkg.compareAtPrice,
        freeShipping: pkg.freeShipping,
        isDefault: pkg.isDefault,
        poolSource: pkg.poolSource,
        slotCount: pkg.slotCount,
        collectionIds: JSON.stringify(pkg.collectionIds),
        variantFilter: pkg.variantFilter,
        tagFilters: JSON.stringify(pkg.tagFilters),
        translations: JSON.stringify(pkg.translations ?? {}),
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
        widgetDescription: input.widgetDescription,
        packPriceTemplate: input.packPriceTemplate,
        pricePerUnitTemplate: input.pricePerUnitTemplate,
        accentColor: input.accentColor,
        showPrices: input.showPrices,
        skipCart: input.skipCart,
        autoCheckout: input.autoCheckout,
        giftsBeforeSlots: input.giftsBeforeSlots,
        poolMode: input.poolMode,
        itemSubtextTemplate: input.itemSubtextTemplate,
        showSubtextOnGifts: input.showSubtextOnGifts,
        freeShipping: input.freeShipping,
        quantityBreakScope: input.quantityBreakScope,
        translations: JSON.stringify(input.translations ?? {}),
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

/**
 * Deep-copies a bundle — items, packages (with their own items), quantity
 * break tiers, and the mix & match rule — and returns the new one.
 *
 * Two things are deliberately NOT carried over:
 *
 * - `shopifyProductId`, and each package's `shopifyVariantId`. These point at
 *   the Shopify product the original published. A copy that kept them would
 *   overwrite the original's product and variants the first time it was set
 *   Active — two bundles writing to one listing, with the second silently
 *   destroying the first. The duplicate publishes its own product instead.
 *   (`createBundle` doesn't accept either field, which is what enforces this;
 *   the mapping below simply never has the chance to pass them.)
 * - `status`. A duplicate always starts as a DRAFT, so copying an active
 *   bundle can't put an unreviewed second listing in front of customers.
 */
export async function duplicateBundle(shop: string, id: string) {
  const source = await prisma.bundle.findFirst({
    where: { id, shop },
    include: {
      items: { orderBy: { position: "asc" } },
      rule: true,
      ...PACKAGES_INCLUDE,
      ...TIERS_INCLUDE,
    },
  });
  if (!source) throw new Response("Bundle not found", { status: 404 });

  // Bundles created from the type picker start untitled; suffixing that would
  // produce a bundle called " (copy)" rather than a blank one the editor
  // still prompts the merchant to name.
  const title = source.title.trim() ? `${source.title} (copy)` : "";

  return createBundle(shop, {
    title,
    description: source.description ?? undefined,
    type: source.type as BundleType,
    status: "DRAFT",
    pricingType: source.pricingType as PricingType,
    pricingValue: source.pricingValue,
    widgetStyle: source.widgetStyle as WidgetStyle,
    widgetHeading: source.widgetHeading,
    widgetDescription: source.widgetDescription,
    packPriceTemplate: source.packPriceTemplate,
    pricePerUnitTemplate: source.pricePerUnitTemplate,
    accentColor: source.accentColor,
    showPrices: source.showPrices,
    skipCart: source.skipCart,
    autoCheckout: source.autoCheckout,
    giftsBeforeSlots: source.giftsBeforeSlots,
    poolMode: source.poolMode,
    itemSubtextTemplate: source.itemSubtextTemplate,
    showSubtextOnGifts: source.showSubtextOnGifts,
    freeShipping: source.freeShipping,
    quantityBreakScope: source.quantityBreakScope,
    translations: parseTranslations<SlotBuilderTranslations>(source.translations, {}),
    items: source.items.map((item, position) => ({
      productId: item.productId,
      variantId: item.variantId,
      productTitle: item.productTitle,
      productImageUrl: item.productImageUrl,
      quantity: item.quantity,
      isGift: item.isGift,
      position,
    })),
    // No `id` on the copies — these have to be created rather than upserted
    // onto the source's rows.
    packages: source.packages.map((pkg, position) => ({
      label: pkg.label,
      badgeText: pkg.badgeText,
      badgeTone: pkg.badgeTone,
      position,
      pricingType: pkg.pricingType as PricingType,
      pricingValue: pkg.pricingValue,
      compareAtPrice: pkg.compareAtPrice,
      freeShipping: pkg.freeShipping,
      isDefault: pkg.isDefault,
      poolSource: pkg.poolSource,
      slotCount: pkg.slotCount,
      collectionIds: JSON.parse(pkg.collectionIds) as string[],
      variantFilter: pkg.variantFilter,
      tagFilters: JSON.parse(pkg.tagFilters) as { label: string; tag: string }[],
      translations: parseTranslations<PackageTranslations>(pkg.translations, {}),
      items: pkg.items.map((item, itemPosition) => ({
        productId: item.productId,
        variantId: item.variantId,
        productTitle: item.productTitle,
        productImageUrl: item.productImageUrl,
        quantity: item.quantity,
        isGift: item.isGift,
        position: itemPosition,
      })),
    })),
    tiers: source.tiers.map((tier, position) => ({
      quantity: tier.quantity,
      label: tier.label,
      badgeText: tier.badgeText,
      badgeTone: tier.badgeTone,
      pricingType: tier.pricingType as PricingType,
      pricingValue: tier.pricingValue,
      isDefault: tier.isDefault,
      position,
      items: tier.items.map((item, itemPosition) => ({
        productId: item.productId,
        variantId: item.variantId,
        productTitle: item.productTitle,
        productImageUrl: item.productImageUrl,
        quantity: item.quantity,
        position: itemPosition,
      })),
    })),
    rule: source.rule
      ? {
          minItems: source.rule.minItems,
          maxItems: source.rule.maxItems,
          discountTiers: JSON.parse(source.rule.discountTiers) as DiscountTier[],
          collectionIds: JSON.parse(source.rule.collectionIds) as string[],
        }
      : null,
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

/**
 * Points a bundle at an existing Shopify product as its parent, for when the
 * link is lost — the product was detached, or a publish half-finished — and
 * the bundle would otherwise create a second, duplicate product on next save.
 *
 * Every package's `shopifyVariantId` is cleared as part of this. Those ids
 * belong to whatever product was linked before and are meaningless (or
 * dangling) against the new one. Clearing them is what makes the reconnect
 * work rather than just not-break: with no id to chase, resolvePackageVariants
 * falls back to matching each package to a variant by its pack option label —
 * exactly the reconciliation a re-linked product needs, and the same path it
 * already uses to recover from a publish that failed partway through.
 *
 * The next publish then reconciles the product: it adds or renames pack option
 * values, repoints prices, and writes the app's metafields. It does NOT touch
 * the product's title or description — nothing here issues a productUpdate.
 * It does delete variants that don't correspond to a package, which is why
 * the UI warns before calling this.
 */
export async function connectBundleProduct(
  shop: string,
  id: string,
  shopifyProductId: string,
) {
  const existing = await prisma.bundle.findFirst({ where: { id, shop } });
  if (!existing) throw new Response("Bundle not found", { status: 404 });

  return prisma.$transaction(async (tx) => {
    await tx.bundlePackage.updateMany({
      where: { bundleId: id },
      data: { shopifyVariantId: null },
    });
    return tx.bundle.update({
      where: { id },
      data: { shopifyProductId },
    });
  });
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
