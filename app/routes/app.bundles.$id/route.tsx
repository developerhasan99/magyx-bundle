import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  TextField,
  Button,
  Banner,
  Badge,
  Divider,
  Box,
  Tooltip,
} from "@shopify/polaris";
import { PlusIcon } from "@shopify/polaris-icons";
import { SaveBar, TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../../shopify.server";
import {
  connectBundleProduct,
  createBundle,
  deleteBundle,
  duplicateBundle,
  getBundle,
  updateBundle,
  type BundleInput,
} from "../../models/bundle.server";
import {
  fetchProductPoolItems,
  fetchShopLocales,
  publishFixedBundleProduct,
  publishSlotBuilderBundleProduct,
  resolveCollectionProductIds,
  syncBundleConfigMetafield,
} from "../../models/shopify-sync.server";
import {
  parseTranslations,
  type PackageTranslations,
  type SlotBuilderTranslations,
} from "../../utils/slot-builder-text";
import {
  defaultPackageState,
  defaultQbTiers,
  type CollectionState,
  type ItemState,
  type PackageState,
  type QbTierState,
  type ResolvedPoolItem,
  type TagFilterState,
  type TierState,
} from "./types";
import { ProductsSection } from "./ProductsSection";
import { GiftsSection } from "./GiftsSection";
import { PricingSection, PricingSummaryBox } from "./PricingSection";
import { PackagesTabsSection, PackageTabsStrip } from "./PackagesTabsSection";
import { PoolModeSelector } from "./PoolModeSelector";
import { QuantityBreaksTiersSection } from "./QuantityBreaksTiersSection";
import { QuantityBreaksWidgetSection } from "./QuantityBreaksWidgetSection";
import { MixMatchRulesSection } from "./MixMatchRulesSection";
import { StorefrontSection } from "./StorefrontSection";
import { TranslationsSection } from "./TranslationsSection";
import { PublishingCard } from "./PublishingCard";
import {
  EditorNav,
  editorSectionsFor,
  type EditorSectionId,
} from "./EditorNav";

const CREATABLE_BUNDLE_TYPES = ["FIXED", "SLOT_BUILDER", "MIX_MATCH", "QUANTITY_BREAKS"];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Used to format every price shown in this editor — merchants on
  // non-USD stores were seeing a hardcoded "$" regardless of their actual
  // currency. Soft-fails to USD so a lookup hiccup doesn't block the page.
  let shopCurrency = "USD";
  try {
    const shopResponse = await admin.graphql(
      `#graphql
      query bundleEditorShopCurrency {
        shop { currencyCode }
      }`,
    );
    shopCurrency = (await shopResponse.json()).data?.shop?.currencyCode ?? "USD";
  } catch (error) {
    console.warn("Magyx Bundle: could not load shop currency", error);
  }

  // Drives the Translations card's language switcher. Fetched for every
  // bundle type (it's one cheap query and the editor can switch type
  // in-session) and soft-fails to a lone "en" primary inside the helper.
  const shopLocales = await fetchShopLocales(admin);

  if (params.id === "new") {
    // Set by the /app/bundles/create type picker so this editor opens with
    // the chosen type pre-selected instead of always defaulting to FIXED.
    const requestedType = new URL(request.url).searchParams.get("type");
    return {
      bundle: null,
      shopifyProduct: null,
      shopCurrency,
      shopLocales,
      requestedType: CREATABLE_BUNDLE_TYPES.includes(requestedType ?? "")
        ? (requestedType as "FIXED" | "SLOT_BUILDER" | "MIX_MATCH" | "QUANTITY_BREAKS")
        : null,
    };
  }

  const bundle = await getBundle(session.shop, params.id!);
  if (!bundle) throw new Response("Not found", { status: 404 });

  let shopifyProduct: {
    title: string;
    status: string;
    imageUrl: string | null;
    price: string | null;
    previewUrl: string | null;
  } | null = null;
  if (bundle.shopifyProductId) {
    try {
      const response = await admin.graphql(
        `#graphql
        query bundleParentProduct($id: ID!) {
          product(id: $id) {
            title
            status
            onlineStorePreviewUrl
            featuredMedia { preview { image { url } } }
            variants(first: 1) { edges { node { price } } }
          }
        }`,
        { variables: { id: bundle.shopifyProductId } },
      );
      const product = (await response.json()).data?.product;
      if (product) {
        shopifyProduct = {
          title: product.title,
          status: product.status,
          imageUrl: product.featuredMedia?.preview?.image?.url ?? null,
          price: product.variants?.edges?.[0]?.node?.price ?? null,
          previewUrl: product.onlineStorePreviewUrl ?? null,
        };
      }
    } catch (error) {
      console.warn("Magyx Bundle: could not load bundle parent product", error);
    }
  }

  // Live component prices so the editor can show the combined (compare-at)
  // price; fetched fresh rather than stored, so price changes are reflected
  const priceByVariant = new Map<string, number>();
  // Distinguishes "lookup failed" from "variant deleted": only flag items as
  // missing when the query itself succeeded
  let pricesLoaded = false;
  const itemVariantIds = Array.from(
    new Set([
      ...bundle.items.map((i) => i.variantId).filter((id): id is string => Boolean(id)),
      ...bundle.packages.flatMap((p) =>
        p.items.map((i) => i.variantId).filter((id): id is string => Boolean(id)),
      ),
      ...bundle.tiers.flatMap((t) =>
        t.items.map((i) => i.variantId).filter((id): id is string => Boolean(id)),
      ),
    ]),
  );
  if (itemVariantIds.length > 0) {
    try {
      const response = await admin.graphql(
        `#graphql
        query bundleItemPrices($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant { id price }
          }
        }`,
        { variables: { ids: itemVariantIds } },
      );
      for (const node of (await response.json()).data?.nodes ?? []) {
        if (node) priceByVariant.set(node.id, parseFloat(node.price));
      }
      pricesLoaded = true;
    } catch (error) {
      console.warn("Magyx Bundle: could not load component prices", error);
    }
  }

  // Resolve collection GIDs into titles/images for the editor UI — from the
  // bundle-wide rule (MIX_MATCH/QUANTITY_BREAKS pool) and, for SLOT_BUILDER,
  // each package's own pool too. Batched into one query across every source
  // instead of one per package.
  const collectionIds: string[] = bundle.rule
    ? (JSON.parse(bundle.rule.collectionIds) as string[])
    : [];
  const packageCollectionIds: string[][] = bundle.packages.map((p) =>
    bundle.type === "SLOT_BUILDER" ? (JSON.parse(p.collectionIds) as string[]) : [],
  );
  const allCollectionIds = Array.from(
    new Set([collectionIds, ...packageCollectionIds].flat()),
  );
  const collectionById = new Map<string, CollectionState>();
  if (allCollectionIds.length > 0) {
    try {
      const response = await admin.graphql(
        `#graphql
        query bundleCollections($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Collection {
              id
              title
              image { url }
            }
          }
        }`,
        { variables: { ids: allCollectionIds } },
      );
      for (const node of (await response.json()).data?.nodes ?? []) {
        if (node) {
          collectionById.set(node.id, {
            id: node.id,
            title: node.title,
            imageUrl: node.image?.url ?? null,
          });
        }
      }
    } catch (error) {
      console.warn("Magyx Bundle: could not load bundle collections", error);
    }
  }
  // Keep the IDs so a failed/partial lookup doesn't wipe selections on next save
  const resolveCollections = (ids: string[]): CollectionState[] =>
    ids.map(
      (id) =>
        collectionById.get(id) ?? {
          id,
          title: `Collection ${id.split("/").pop()}`,
          imageUrl: null,
        },
    );
  const collections = resolveCollections(collectionIds);

  // Live preview of what each COLLECTIONS-sourced pool actually resolves to
  // right now — every variant of every member product, same shape (and same
  // resolver) the storefront proxy uses at add-to-cart time. Bundle-level
  // for MIX_MATCH's pool / QUANTITY_BREAKS' "applies to"; per-package for
  // SLOT_BUILDER. Uncapped by design: a merchant should never have a pool
  // silently truncated in the editor. Soft-fails per collection so one bad
  // lookup doesn't blank out every preview.
  const resolveCollectionPoolItems = async (
    ids: string[],
    variantFilter?: string,
  ): Promise<ResolvedPoolItem[]> => {
    if (ids.length === 0) return [];
    try {
      const productIds = await resolveCollectionProductIds(admin, ids);
      const items = await fetchProductPoolItems(
        admin,
        productIds,
        bundle.itemSubtextTemplate,
        variantFilter,
      );
      return items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        title: item.title,
        imageUrl: item.image,
        price: item.price,
        available: item.available,
      }));
    } catch (error) {
      console.warn("Magyx Bundle: could not resolve collection pool preview", error);
      return [];
    }
  };
  // SLOT_BUILDER's per-package pool is NOT auto-resolved here — it's
  // uncapped (a merchant should never have it silently truncated) and can
  // be a large collection, so the editor resolves it only on demand via the
  // "Resolve products" button (app.bundles.resolve-pool.tsx) instead of on
  // every page load.
  const collectionPoolItems =
    bundle.type !== "FIXED" && bundle.type !== "SLOT_BUILDER"
      ? await resolveCollectionPoolItems(collectionIds)
      : [];

  return {
    shopifyProduct,
    shopCurrency,
    shopLocales,
    requestedType: null,
    bundle: {
      id: bundle.id,
      title: bundle.title,
      description: bundle.description ?? "",
      type: bundle.type,
      status: bundle.status,
      pricingType: bundle.pricingType,
      pricingValue: bundle.pricingValue,
      shopifyProductId: bundle.shopifyProductId,
      widgetStyle: bundle.widgetStyle,
      widgetHeading: bundle.widgetHeading,
      accentColor: bundle.accentColor,
      showPrices: bundle.showPrices,
      skipCart: bundle.skipCart,
      autoCheckout: bundle.autoCheckout,
      poolMode: bundle.poolMode,
      itemSubtextTemplate: bundle.itemSubtextTemplate,
      showSubtextOnGifts: bundle.showSubtextOnGifts,
      freeShipping: bundle.freeShipping,
      quantityBreakScope: bundle.quantityBreakScope,
      translations: parseTranslations<SlotBuilderTranslations>(bundle.translations, {}),
      items: bundle.items.map((i) => ({
        productId: i.productId,
        variantId: i.variantId,
        productTitle: i.productTitle,
        productImageUrl: i.productImageUrl,
        quantity: i.quantity,
        isGift: i.isGift,
        price: i.variantId ? (priceByVariant.get(i.variantId) ?? null) : null,
        missing:
          pricesLoaded && Boolean(i.variantId) && !priceByVariant.has(i.variantId!),
      })),
      packages: bundle.packages.map((p, index) => ({
        id: p.id,
        label: p.label,
        badgeText: p.badgeText,
        badgeTone: p.badgeTone,
        pricingType: p.pricingType,
        pricingValue: p.pricingValue,
        freeShipping: p.freeShipping,
        shopifyVariantId: p.shopifyVariantId,
        poolSource: p.poolSource,
        slotCount: p.slotCount,
        collections: resolveCollections(packageCollectionIds[index]),
        // Not auto-resolved on load — see the comment above collectionPoolItems.
        collectionPoolItems: [] as ResolvedPoolItem[],
        variantFilter: p.variantFilter,
        tagFilters: JSON.parse(p.tagFilters) as TagFilterState[],
        translations: parseTranslations<PackageTranslations>(p.translations, {}),
        items: p.items.map((i) => ({
          productId: i.productId,
          variantId: i.variantId,
          productTitle: i.productTitle,
          productImageUrl: i.productImageUrl,
          quantity: i.quantity,
          isGift: i.isGift,
          price: i.variantId ? (priceByVariant.get(i.variantId) ?? null) : null,
          missing:
            pricesLoaded && Boolean(i.variantId) && !priceByVariant.has(i.variantId!),
        })),
      })),
      collections,
      collectionPoolItems,
      tiers: bundle.tiers.map((t) => ({
        id: t.id,
        quantity: t.quantity,
        label: t.label,
        badgeText: t.badgeText,
        badgeTone: t.badgeTone,
        pricingType: t.pricingType,
        pricingValue: t.pricingValue,
        isDefault: t.isDefault,
        items: t.items.map((i) => ({
          productId: i.productId,
          variantId: i.variantId,
          productTitle: i.productTitle,
          productImageUrl: i.productImageUrl,
          quantity: i.quantity,
          price: i.variantId ? (priceByVariant.get(i.variantId) ?? null) : null,
          missing:
            pricesLoaded && Boolean(i.variantId) && !priceByVariant.has(i.variantId!),
        })),
      })),
      rule: bundle.rule
        ? {
            minItems: bundle.rule.minItems,
            maxItems: bundle.rule.maxItems,
            discountTiers: JSON.parse(bundle.rule.discountTiers) as {
              quantity: number;
              discount: number;
            }[],
            collectionIds,
          }
        : null,
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete" && params.id !== "new") {
    await deleteBundle(session.shop, params.id!);
    await syncBundleConfigMetafield(admin, session.shop);
    return redirect("/app");
  }

  // Re-links a bundle to an existing product. No publish here: the merchant
  // saves afterwards, and that save runs the normal reconcile path — which
  // is the same code that would have run had the link never been lost.
  if (intent === "connect-product" && params.id !== "new") {
    const productId = String(formData.get("productId") ?? "");
    if (!productId.startsWith("gid://shopify/Product/")) {
      return { errors: ["That doesn't look like a product. Pick one from the list."] };
    }
    await connectBundleProduct(session.shop, params.id!, productId);
    return { connected: true };
  }

  // The copy is always a DRAFT and owns no Shopify product yet (see
  // duplicateBundle), so there is nothing to publish and no reason to
  // resync the checkout metafield — only ACTIVE bundles appear in it.
  if (intent === "duplicate" && params.id !== "new") {
    const copy = await duplicateBundle(session.shop, params.id!);
    return redirect(`/app/bundles/${copy.id}`);
  }

  const payload = JSON.parse(String(formData.get("payload"))) as BundleInput & {
    rule?: { minItems: number; maxItems: number | null; discountTiers: { quantity: number; discount: number }[]; collectionIds: string[] } | null;
  };

  const errors: string[] = [];
  const hasPool =
    payload.items.length > 0 || (payload.rule?.collectionIds?.length ?? 0) > 0;
  if (!payload.title?.trim()) errors.push("Title is required.");
  if (payload.type === "FIXED") {
    if (payload.packages.length === 0) errors.push("Add at least one package.");
    payload.packages.forEach((pkg, i) => {
      const label = pkg.label?.trim() || `Package ${i + 1}`;
      if (!pkg.label?.trim()) errors.push(`Package ${i + 1} needs a title.`);
      if (pkg.items.filter((item) => !item.isGift).length < 2)
        errors.push(`"${label}" needs at least two products.`);
      if (pkg.pricingValue < 0) errors.push(`"${label}" pricing value can't be negative.`);
      if (pkg.pricingType === "PERCENT_OFF" && pkg.pricingValue > 100)
        errors.push(`"${label}" discount can't be more than 100%.`);
    });
  } else if (payload.type === "SLOT_BUILDER") {
    // Each package has its own pool + slot count now, not the bundle overall.
    if (payload.packages.length === 0) errors.push("Add at least one package.");
    payload.packages.forEach((pkg, i) => {
      const label = pkg.label?.trim() || `Package ${i + 1}`;
      if (!pkg.label?.trim()) errors.push(`Package ${i + 1} needs a title.`);
      if (pkg.pricingValue < 0) errors.push(`"${label}" pricing value can't be negative.`);
      const pkgHasPool =
        pkg.items.some((item) => !item.isGift) || (pkg.collectionIds?.length ?? 0) > 0;
      if (!pkgHasPool)
        errors.push(`"${label}" needs products or a collection for customers to pick from.`);
      if ((pkg.slotCount ?? 0) < 2) errors.push(`"${label}" needs at least two slots.`);
    });
  } else if (payload.type === "QUANTITY_BREAKS") {
    if (payload.quantityBreakScope === "PRODUCTS" && payload.items.length === 0)
      errors.push("Select at least one product this applies to.");
    if (
      payload.quantityBreakScope === "COLLECTIONS" &&
      (payload.rule?.collectionIds?.length ?? 0) === 0
    )
      errors.push("Select at least one collection this applies to.");
    if ((payload.tiers?.length ?? 0) === 0) errors.push("Add at least one pack size.");
    payload.tiers?.forEach((tier, i) => {
      const label = tier.label?.trim() || `Tier ${i + 1}`;
      if (!tier.quantity || tier.quantity < 1)
        errors.push(`"${label}" needs a quantity of at least 1.`);
      if (tier.pricingValue < 0) errors.push(`"${label}" pricing value can't be negative.`);
      if (tier.pricingType === "PERCENT_OFF" && tier.pricingValue > 100)
        errors.push(`"${label}" discount can't be more than 100%.`);
    });
  } else {
    if (!hasPool)
      errors.push("Add products or select at least one collection for customers to pick from.");
    if (payload.pricingValue < 0) errors.push("Pricing value can't be negative.");
    if (payload.pricingType === "PERCENT_OFF" && payload.pricingValue > 100)
      errors.push("Discount can't be more than 100%.");
  }
  if (payload.type === "MIX_MATCH" && (payload.rule?.discountTiers?.length ?? 0) === 0)
    errors.push("Add at least one discount tier.");
  if (payload.rule?.discountTiers?.some((t) => t.discount > 100))
    errors.push("Tier discounts can't be more than 100%.");
  if (errors.length) return { errors };

  const input: BundleInput = {
    ...payload,
    items: payload.items.map((item, position) => ({ ...item, position })),
    packages: payload.packages.map((pkg, position) => ({
      ...pkg,
      // Bundle builder is fixed-price only — a customer's slot picks aren't
      // known until checkout, so there's no trustworthy "combined price" to
      // discount off of. Enforced here too (not just hidden in the UI) so a
      // tampered payload can't sneak a different pricing type into the DB.
      pricingType: payload.type === "SLOT_BUILDER" ? "FIXED_PRICE" : pkg.pricingType,
      position,
      items: pkg.items.map((item, itemPosition) => ({ ...item, position: itemPosition })),
    })),
    tiers: (payload.tiers ?? []).map((tier, position) => ({
      ...tier,
      position,
      items: (tier.items ?? []).map((item, itemPosition) => ({ ...item, position: itemPosition })),
    })),
    // QUANTITY_BREAKS only sends a rule when scoped to collections (see
    // save()'s payload construction) — falls through to payload.rule as-is.
    // SLOT_BUILDER's pool/slot count now live per package instead of a
    // bundle-level rule (same as FIXED, which never had one).
    rule: payload.type === "FIXED" || payload.type === "SLOT_BUILDER" ? null : payload.rule,
  };

  const bundle =
    params.id === "new"
      ? await createBundle(session.shop, input)
      : await updateBundle(session.shop, params.id!, input);

  // Publishing a fixed bundle creates/updates its parent product in Shopify
  if (bundle.type === "FIXED" && bundle.status === "ACTIVE") {
    try {
      await publishFixedBundleProduct(
        admin,
        {
          bundleId: bundle.id,
          title: bundle.title,
          description: bundle.description,
          widgetSettings: {
            style: bundle.widgetStyle,
            heading: bundle.widgetHeading,
            accentColor: bundle.accentColor,
            showPrices: bundle.showPrices,
            itemSubtextTemplate: bundle.itemSubtextTemplate,
            showSubtextOnGifts: bundle.showSubtextOnGifts,
          },
          packages: bundle.packages.map((pkg) => ({
            packageId: pkg.id,
            existingVariantId: pkg.shopifyVariantId,
            label: pkg.label,
            badgeText: pkg.badgeText,
            badgeTone: pkg.badgeTone,
            pricingType: pkg.pricingType,
            pricingValue: pkg.pricingValue,
            freeShipping: pkg.freeShipping,
            componentVariantIds: pkg.items
              .filter((i) => i.variantId)
              .map((i) => ({ variantId: i.variantId!, quantity: i.quantity, isGift: i.isGift })),
            displayItems: pkg.items.map((i) => ({
              title: i.productTitle,
              imageUrl: i.productImageUrl,
              quantity: i.quantity,
              productId: i.productId,
              variantId: i.variantId,
              isGift: i.isGift,
            })),
          })),
        },
        bundle.shopifyProductId,
      );
    } catch (error) {
      return {
        errors: [
          `Bundle saved, but publishing the product failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        ],
      };
    }
  }

  // Publishing a bundle builder bundle creates/updates its parent product,
  // same as FIXED — the difference is there are no paid components to
  // snapshot (the customer's slot picks aren't known until checkout).
  if (bundle.type === "SLOT_BUILDER" && bundle.status === "ACTIVE") {
    try {
      // The widget falls back to this locale's copy before falling back to
      // its own built-in English, so a shop whose default copy isn't English
      // stays in its own language on markets it hasn't translated for.
      // Empty when the locale lookup failed — guessing "en" here would point
      // the widget's fallback at a bucket that doesn't exist on, say, a
      // Swedish shop. The widget skips an empty locale in the chain.
      const primaryLocale =
        (await fetchShopLocales(admin)).find((l) => l.primary)?.locale ?? "";
      await publishSlotBuilderBundleProduct(
        admin,
        {
          bundleId: bundle.id,
          title: bundle.title,
          description: bundle.description,
          primaryLocale,
          translations: parseTranslations<SlotBuilderTranslations>(
            bundle.translations,
            {},
          ),
          widgetSettings: {
            heading: bundle.widgetHeading,
            accentColor: bundle.accentColor,
            showPrices: bundle.showPrices,
            skipCart: bundle.skipCart,
            autoCheckout: bundle.skipCart && bundle.autoCheckout,
            itemSubtextTemplate: bundle.itemSubtextTemplate,
            showSubtextOnGifts: bundle.showSubtextOnGifts,
          },
          packages: bundle.packages.map((pkg) => ({
            packageId: pkg.id,
            existingVariantId: pkg.shopifyVariantId,
            label: pkg.label,
            badgeText: pkg.badgeText,
            badgeTone: pkg.badgeTone,
            pricingValue: pkg.pricingValue,
            freeShipping: pkg.freeShipping,
            poolSource: pkg.poolSource,
            slotCount: pkg.slotCount,
            poolVariantIds: pkg.items
              .filter((i) => !i.isGift && i.variantId)
              .map((i) => i.variantId!),
            collectionIds: JSON.parse(pkg.collectionIds) as string[],
            variantFilter: pkg.variantFilter,
            tagFilters: JSON.parse(pkg.tagFilters) as { label: string; tag: string }[],
            translations: parseTranslations<PackageTranslations>(pkg.translations, {}),
            gifts: pkg.items
              .filter((i) => i.isGift && i.variantId)
              .map((i) => ({ variantId: i.variantId!, quantity: i.quantity })),
            giftDisplayItems: pkg.items
              .filter((i) => i.isGift)
              .map((i) => ({
                title: i.productTitle,
                imageUrl: i.productImageUrl,
                quantity: i.quantity,
                productId: i.productId,
                variantId: i.variantId,
              })),
          })),
        },
        bundle.shopifyProductId,
      );
    } catch (error) {
      return {
        errors: [
          `Bundle saved, but publishing the product failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        ],
      };
    }
  }

  await syncBundleConfigMetafield(admin, session.shop);

  if (params.id === "new") return redirect(`/app/bundles/${bundle.id}`);
  return { saved: true };
};

type LoaderBundle = SerializeFrom<typeof loader>["bundle"];

// Derives editor form state from the loaded bundle. Used for initial values,
// for resetting on discard, and as the baseline for dirty-state detection —
// keep field order stable, the dirty check compares JSON serializations.
function formStateOf(bundle: LoaderBundle, requestedType?: string | null) {
  const type = bundle?.type ?? requestedType ?? "FIXED";
  return {
    title: bundle?.title ?? "",
    type,
    status: bundle?.status ?? "DRAFT",
    pricingType:
      bundle?.pricingType ?? (type === "MIX_MATCH" ? "PERCENT_OFF" : "FIXED_PRICE"),
    pricingValue: String(bundle?.pricingValue ?? ""),
    widgetStyle: bundle?.widgetStyle ?? "numbered",
    // "What's inside" only makes sense as a default for FIXED (static
    // contents) — Bundle Builder has nothing "inside" until the customer
    // picks, so a new one starts with no heading unless the merchant sets one.
    widgetHeading: bundle?.widgetHeading ?? (type === "SLOT_BUILDER" ? "" : "What's inside"),
    accentColor: bundle?.accentColor ?? "#1a1a1a",
    showPrices: bundle?.showPrices ?? false,
    skipCart: bundle?.skipCart ?? false,
    autoCheckout: bundle?.autoCheckout ?? false,
    poolMode: bundle?.poolMode ?? "PER_PACKAGE",
    itemSubtextTemplate: bundle?.itemSubtextTemplate ?? "",
    showSubtextOnGifts: bundle?.showSubtextOnGifts ?? true,
    freeShipping: bundle?.freeShipping ?? false,
    translations: (bundle?.translations ?? {}) as SlotBuilderTranslations,
    items:
      bundle?.items.map((i): ItemState => ({
        productId: i.productId,
        variantId: i.variantId ?? null,
        productTitle: i.productTitle,
        productImageUrl: i.productImageUrl ?? null,
        quantity: i.quantity,
        isGift: i.isGift ?? false,
        price: i.price ?? null,
        missing: i.missing ?? false,
      })) ?? [],
    packages:
      bundle?.packages && bundle.packages.length > 0
        ? bundle.packages.map(
            (p): PackageState => ({
              id: p.id,
              tempKey: p.id,
              label: p.label,
              badgeText: p.badgeText ?? "",
              badgeTone: p.badgeTone ?? "",
              pricingType: p.pricingType,
              pricingValue: String(p.pricingValue),
              freeShipping: p.freeShipping,
              poolSource: p.poolSource ?? "PRODUCTS",
              collections: (p.collections ?? []) as CollectionState[],
              collectionPoolItems: (p.collectionPoolItems ?? []) as ResolvedPoolItem[],
              variantFilter: p.variantFilter ?? "",
              tagFilters: (p.tagFilters ?? []) as TagFilterState[],
              slotCount: String(p.slotCount ?? 2),
              translations: (p.translations ?? {}) as PackageTranslations,
              items: p.items.map(
                (i): ItemState => ({
                  productId: i.productId,
                  variantId: i.variantId ?? null,
                  productTitle: i.productTitle,
                  productImageUrl: i.productImageUrl ?? null,
                  quantity: i.quantity,
                  isGift: i.isGift ?? false,
                  price: i.price ?? null,
                  missing: i.missing ?? false,
                }),
              ),
            }),
          )
        : [defaultPackageState()],
    collections: (bundle?.collections ?? []) as CollectionState[],
    collectionPoolItems: (bundle?.collectionPoolItems ?? []) as ResolvedPoolItem[],
    // QUANTITY_BREAKS persists its scope explicitly (it needs a distinct
    // "ALL" value that can't be inferred from an empty items/collections
    // list); every other type still infers it from whether collections exist.
    poolSource:
      bundle?.type === "QUANTITY_BREAKS"
        ? (bundle.quantityBreakScope ?? "PRODUCTS")
        : (bundle?.collections?.length ?? 0) > 0
          ? "COLLECTIONS"
          : "PRODUCTS",
    minItems: String((bundle?.type === "MIX_MATCH" && bundle?.rule?.minItems) || 2),
    maxItems: bundle?.rule?.maxItems ? String(bundle.rule.maxItems) : "",
    tiers:
      bundle?.rule?.discountTiers.map(
        (t): TierState => ({
          quantity: String(t.quantity),
          discount: String(t.discount),
        }),
      ) ?? [{ quantity: "2", discount: "10" }],
    qbTiers:
      bundle?.tiers && bundle.tiers.length > 0
        ? bundle.tiers.map(
            (t): QbTierState => ({
              id: t.id,
              tempKey: t.id,
              quantity: String(t.quantity),
              label: t.label,
              badgeText: t.badgeText ?? "",
              badgeTone: t.badgeTone ?? "",
              pricingType: t.pricingType,
              pricingValue: String(t.pricingValue),
              isDefault: t.isDefault,
              items: t.items.map(
                (i): ItemState => ({
                  productId: i.productId,
                  variantId: i.variantId ?? null,
                  productTitle: i.productTitle,
                  productImageUrl: i.productImageUrl ?? null,
                  quantity: i.quantity,
                  isGift: true,
                  price: i.price ?? null,
                  missing: i.missing ?? false,
                }),
              ),
            }),
          )
        : defaultQbTiers(),
  };
}

export default function BundleBuilder() {
  const { bundle, shopifyProduct, shopCurrency, shopLocales, requestedType } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const deleteFetcher = useFetcher<typeof action>();
  const duplicateFetcher = useFetcher<typeof action>();
  const connectFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const isNew = !bundle;
  // FIXED/SLOT_BUILDER packages each become their own Shopify product
  // variant. Once the bundle has actually been published (has a real
  // Shopify product), adding a new package means reconciling that variant
  // set live against the Shopify Product Options API — order-sensitive and
  // has sharp edges (e.g. reusing a label from a since-deleted package can
  // collide with a leftover, orphaned option value). Safer to just not
  // offer it once there's a live product; removing/editing existing
  // packages is unaffected, since deleting a variant has no such edge cases.
  const canAddPackage = !bundle?.shopifyProductId;

  const initialForm = useMemo(
    () => formStateOf(bundle, requestedType),
    [bundle, requestedType],
  );

  const [title, setTitle] = useState(initialForm.title);
  // No longer editable in the UI, but sent on save so existing values persist
  const description = bundle?.description ?? "";
  const [type, setType] = useState<string>(initialForm.type);
  const [status, setStatus] = useState<string>(initialForm.status);
  const [pricingType, setPricingType] = useState<string>(initialForm.pricingType);
  const [pricingValue, setPricingValue] = useState(initialForm.pricingValue);
  const [widgetStyle, setWidgetStyle] = useState(initialForm.widgetStyle);
  const [widgetHeading, setWidgetHeading] = useState(initialForm.widgetHeading);
  const [accentColor, setAccentColor] = useState(initialForm.accentColor);
  const [showPrices, setShowPrices] = useState(initialForm.showPrices);
  const [skipCart, setSkipCart] = useState(initialForm.skipCart);
  const [autoCheckout, setAutoCheckout] = useState(initialForm.autoCheckout);
  const [poolMode, setPoolMode] = useState(initialForm.poolMode);
  const [itemSubtextTemplate, setItemSubtextTemplate] = useState(
    initialForm.itemSubtextTemplate,
  );
  const [showSubtextOnGifts, setShowSubtextOnGifts] = useState(
    initialForm.showSubtextOnGifts,
  );
  const [freeShipping, setFreeShipping] = useState(initialForm.freeShipping);
  const [translations, setTranslations] = useState<SlotBuilderTranslations>(
    initialForm.translations,
  );
  const [items, setItems] = useState<ItemState[]>(initialForm.items);
  const [packages, setPackages] = useState<PackageState[]>(initialForm.packages);
  const [activePackageIndex, setActivePackageIndex] = useState(0);
  const [selectedSection, setSelectedSection] = useState<EditorSectionId>("general");
  const [collections, setCollections] = useState<CollectionState[]>(
    initialForm.collections,
  );
  // Read-only live preview, never edited client-side — refreshes whenever
  // the loader re-runs (e.g. after save), no local state needed.
  const collectionPoolItems = initialForm.collectionPoolItems;
  const [poolSource, setPoolSource] = useState<string>(initialForm.poolSource);
  const [minItems, setMinItems] = useState(initialForm.minItems);
  const [maxItems, setMaxItems] = useState(initialForm.maxItems);
  const [tiers, setTiers] = useState<TierState[]>(initialForm.tiers);
  const [qbTiers, setQbTiers] = useState<QbTierState[]>(initialForm.qbTiers);
  const [activeQbTierIndex, setActiveQbTierIndex] = useState(0);

  // Keep the active tab in range when a package is added (select it) or
  // removed (fall back to the last remaining one)
  const prevPackagesLengthRef = useRef(packages.length);
  useEffect(() => {
    if (packages.length > prevPackagesLengthRef.current) {
      setActivePackageIndex(packages.length - 1);
    } else if (activePackageIndex >= packages.length) {
      setActivePackageIndex(Math.max(0, packages.length - 1));
    }
    prevPackagesLengthRef.current = packages.length;
  }, [packages.length, activePackageIndex]);

  // Same in-range/auto-select behavior as packages above, for pack-size tabs
  const prevQbTiersLengthRef = useRef(qbTiers.length);
  useEffect(() => {
    if (qbTiers.length > prevQbTiersLengthRef.current) {
      setActiveQbTierIndex(qbTiers.length - 1);
    } else if (activeQbTierIndex >= qbTiers.length) {
      setActiveQbTierIndex(Math.max(0, qbTiers.length - 1));
    }
    prevQbTiersLengthRef.current = qbTiers.length;
  }, [qbTiers.length, activeQbTierIndex]);

  // FIXED bundles source their item list/pricing from the active package;
  // every other type keeps using the flat top-level state exactly as before
  const activeItems = useMemo(
    () =>
      type === "FIXED" || type === "SLOT_BUILDER"
        ? (packages[activePackageIndex]?.items ?? [])
        : items,
    [type, packages, activePackageIndex, items],
  );
  const activePricingType =
    type === "FIXED" || type === "SLOT_BUILDER"
      ? (packages[activePackageIndex]?.pricingType ?? "FIXED_PRICE")
      : pricingType;
  const activePricingValue =
    type === "FIXED" || type === "SLOT_BUILDER"
      ? (packages[activePackageIndex]?.pricingValue ?? "")
      : pricingValue;

  const setActiveItems = useCallback(
    (updater: (current: ItemState[]) => ItemState[]) => {
      if (type === "FIXED" || type === "SLOT_BUILDER") {
        setPackages((current) =>
          current.map((pkg, i) =>
            i === activePackageIndex ? { ...pkg, items: updater(pkg.items) } : pkg,
          ),
        );
      } else {
        setItems(updater);
      }
    },
    [type, activePackageIndex],
  );

  // Turning skip cart off takes the widget's own button away, so auto
  // checkout has nothing left to drive — clear it rather than leaving a
  // checked-but-disabled box that would quietly switch back on later.
  const onSkipCartChange = useCallback((value: boolean) => {
    setSkipCart(value);
    if (!value) setAutoCheckout(false);
  }, []);

  const updatePackageAt = useCallback((index: number, patch: Partial<PackageState>) => {
    setPackages((current) =>
      current.map((pkg, i) => (i === index ? { ...pkg, ...patch } : pkg)),
    );
  }, []);

  const updateActivePackage = useCallback(
    (patch: Partial<PackageState>) => updatePackageAt(activePackageIndex, patch),
    [updatePackageAt, activePackageIndex],
  );

  /* SLOT_BUILDER pools come in two shapes, chosen by the merchant:
     - PER_PACKAGE (default): each package defines its own pool, so a "30ml"
       package can offer different products than "100ml".
     - GLOBAL: one pool every package draws from. Stored by writing the same
       pool onto every package, so only this file knows the mode exists.

     Reads therefore come from a single canonical package — package 0 under
     GLOBAL, since that's the one the fan-out copies from — and writes go to
     every package at once. Slot count, pricing, gifts and labels stay
     per-package in both modes; only the pool itself is shared. */
  const isGlobalPool = type === "SLOT_BUILDER" && poolMode === "GLOBAL";
  const poolPackageIndex = isGlobalPool ? 0 : activePackageIndex;

  const updatePoolFields = useCallback(
    (patch: Partial<PackageState>) =>
      setPackages((current) =>
        current.map((pkg, i) =>
          isGlobalPool || i === activePackageIndex ? { ...pkg, ...patch } : pkg,
        ),
      ),
    [isGlobalPool, activePackageIndex],
  );

  const activePoolSource =
    type === "SLOT_BUILDER" ? (packages[poolPackageIndex]?.poolSource ?? "PRODUCTS") : poolSource;
  const activeCollections =
    type === "SLOT_BUILDER" ? (packages[poolPackageIndex]?.collections ?? []) : collections;
  const activeCollectionPoolItems =
    type === "SLOT_BUILDER"
      ? (packages[poolPackageIndex]?.collectionPoolItems ?? [])
      : collectionPoolItems;
  // SLOT_BUILDER only — MIX_MATCH/QUANTITY_BREAKS don't offer this filter.
  const activeVariantFilter = packages[poolPackageIndex]?.variantFilter ?? "";
  const setActiveVariantFilter = useCallback(
    (value: string) => updatePoolFields({ variantFilter: value }),
    [updatePoolFields],
  );
  // SLOT_BUILDER only: the pool modal's filter chips (button text + product
  // tag per row). Part of the pool, so shared under GLOBAL.
  const activeTagFilters = packages[poolPackageIndex]?.tagFilters ?? [];
  const setActiveTagFilters = useCallback(
    (updater: (current: TagFilterState[]) => TagFilterState[]) =>
      setPackages((current) => {
        const next = updater(current[isGlobalPool ? 0 : activePackageIndex]?.tagFilters ?? []);
        return current.map((pkg, i) =>
          isGlobalPool || i === activePackageIndex ? { ...pkg, tagFilters: next } : pkg,
        );
      }),
    [isGlobalPool, activePackageIndex],
  );

  /* The pool half of a package's `items`. Separate from setActiveItems (which
     gifts use) because gifts are never shared: the updater runs against the
     canonical package's full list so existing callers are unchanged, then only
     the non-gift result is copied outward, leaving each package's own gifts
     alone. */
  /* Switching to GLOBAL copies the canonical package's pool onto the others
     immediately rather than waiting for save. Without it the merchant would
     flip the toggle, see package 0's pool, and only find out at save time
     that it replaced what the other packages had — the editor should show
     what it's about to persist. */
  const onPoolModeChange = useCallback(
    (value: string) => {
      setPoolMode(value);
      if (value !== "GLOBAL") return;
      setPackages((current) => {
        const template = current[0];
        if (!template) return current;
        const templatePool = template.items.filter((i) => !i.isGift);
        return current.map((pkg) => ({
          ...pkg,
          poolSource: template.poolSource,
          collections: template.collections,
          collectionPoolItems: template.collectionPoolItems,
          variantFilter: template.variantFilter,
          tagFilters: template.tagFilters,
          items: [...pkg.items.filter((i) => i.isGift), ...templatePool],
        }));
      });
    },
    [],
  );

  const setPoolItems = useCallback(
    (updater: (current: ItemState[]) => ItemState[]) =>
      setPackages((current) => {
        const sourceIndex = isGlobalPool ? 0 : activePackageIndex;
        const next = updater(current[sourceIndex]?.items ?? []);
        if (!isGlobalPool) {
          return current.map((pkg, i) => (i === sourceIndex ? { ...pkg, items: next } : pkg));
        }
        const nextPool = next.filter((i) => !i.isGift);
        return current.map((pkg) => ({
          ...pkg,
          items: [...pkg.items.filter((i) => i.isGift), ...nextPool],
        }));
      }),
    [isGlobalPool, activePackageIndex],
  );

  // Resolving a COLLECTIONS pool is uncapped (see the loader) and can be
  // slow for a large collection, so it's triggered on demand by the
  // "Resolve products" button instead of running on every page load.
  const resolvePoolFetcher = useFetcher<{ items: ResolvedPoolItem[]; error?: string }>();
  const isResolvingPool = resolvePoolFetcher.state !== "idle";
  const resolveActivePoolProducts = useCallback(() => {
    resolvePoolFetcher.submit(
      {
        collectionIds: JSON.stringify(activeCollections.map((c) => c.id)),
        variantFilter: activeVariantFilter,
        itemSubtextTemplate,
      },
      { method: "POST", action: "/app/bundles/resolve-pool" },
    );
  }, [resolvePoolFetcher, activeCollections, activeVariantFilter, itemSubtextTemplate]);
  useEffect(() => {
    // The action's data arrives while the fetcher is still "loading"
    // (revalidating), so state must be a dependency too — waiting on data
    // alone means the idle guard fails once and never re-checks.
    if (resolvePoolFetcher.data && resolvePoolFetcher.state === "idle") {
      updatePoolFields({ collectionPoolItems: resolvePoolFetcher.data.items });
    }
    // Deliberately omits updatePoolFields so switching package tabs
    // doesn't re-apply a stale result to the newly active package.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvePoolFetcher.data, resolvePoolFetcher.state]);
  const setActivePoolSource = useCallback(
    (value: string) => {
      if (type === "SLOT_BUILDER") updatePoolFields({ poolSource: value });
      else setPoolSource(value);
    },
    [type, updatePoolFields],
  );
  const setActiveCollections = useCallback(
    (updater: (current: CollectionState[]) => CollectionState[]) => {
      if (type === "SLOT_BUILDER") {
        setPackages((current) => {
          const next = updater(current[isGlobalPool ? 0 : activePackageIndex]?.collections ?? []);
          return current.map((pkg, i) =>
            isGlobalPool || i === activePackageIndex ? { ...pkg, collections: next } : pkg,
          );
        });
      } else {
        setCollections(updater);
      }
    },
    [type, isGlobalPool, activePackageIndex],
  );

  const addPackage = useCallback(() => {
    setPackages((current) => {
      const fresh = {
        ...defaultPackageState(),
        tempKey: `new-${Date.now()}`,
        label: `Pack ${current.length + 1}`,
      };
      // Under a GLOBAL pool a new package has to start with the shared pool,
      // not an empty one — otherwise it renders as a package customers can't
      // pick anything from until the next pool edit or save fans it out.
      // Everything else (slots, price, gifts) stays at its defaults.
      const template = current[0];
      if (!isGlobalPool || !template) return [...current, fresh];
      return [
        ...current,
        {
          ...fresh,
          poolSource: template.poolSource,
          collections: template.collections,
          collectionPoolItems: template.collectionPoolItems,
          variantFilter: template.variantFilter,
          tagFilters: template.tagFilters,
          items: template.items.filter((i) => !i.isGift),
        },
      ];
    });
  }, [isGlobalPool]);

  const removeActivePackage = useCallback(() => {
    setPackages((current) => current.filter((_, i) => i !== activePackageIndex));
  }, [activePackageIndex]);

  // paidItems/giftItems split the active items list for rendering and price
  // math without mutating storage shape. FIXED and SLOT_BUILDER both keep
  // paid + gift items in one package-scoped list (SLOT_BUILDER's "paid"
  // items are its product pool, not fixed contents); every other type keeps
  // using the flat top-level `items` list, which never carries gifts.
  const paidItems = useMemo(() => activeItems.filter((i) => !i.isGift), [activeItems]);
  const giftItems = useMemo(() => activeItems.filter((i) => i.isGift), [activeItems]);

  // SLOT_BUILDER gifts and free shipping inherit forward: a package ships its
  // own plus every earlier package's (see syncBundleConfigMetafield). The
  // editor only ever shows one package's own items, so surface what's coming
  // from upstream too — otherwise a merchant reads an empty gift list or an
  // unchecked free-shipping box as "this package has none".
  const earlierPackages = useMemo(
    () => (type === "SLOT_BUILDER" ? packages.slice(0, activePackageIndex) : []),
    [type, packages, activePackageIndex],
  );
  const inheritedFreeShipping = useMemo(
    () => earlierPackages.some((p) => p.freeShipping),
    [earlierPackages],
  );
  // Deduped by variant, and anything this package defines itself is dropped —
  // that copy is already editable in the list above.
  const inheritedGiftItems = useMemo(() => {
    const ownKeys = new Set(giftItems.map((i) => i.variantId ?? i.productId));
    const seen = new Set<string>();
    const inherited: ItemState[] = [];
    for (const pkg of earlierPackages) {
      for (const item of pkg.items) {
        if (!item.isGift) continue;
        const key = item.variantId ?? item.productId;
        if (ownKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        inherited.push(item);
      }
    }
    return inherited;
  }, [earlierPackages, giftItems]);

  const isSaving = fetcher.state !== "idle";

  // Per-package collectionPoolItems is live preview data fetched on demand
  // by the "Resolve products" button, never persisted and always empty in
  // initialForm (see the loader) — stripped from both sides before
  // comparing so clicking that button doesn't itself register as an edit.
  const stripCollectionPoolItems = (pkgs: PackageState[]) =>
    pkgs.map(({ collectionPoolItems: _collectionPoolItems, ...pkg }) => pkg);
  const isDirty = useMemo(
    () =>
      JSON.stringify({
        title, type, status, pricingType, pricingValue, widgetStyle,
        widgetHeading, accentColor, showPrices, skipCart, autoCheckout, poolMode,
        itemSubtextTemplate, showSubtextOnGifts, freeShipping, translations, items,
        packages: stripCollectionPoolItems(packages),
        collections, collectionPoolItems, poolSource,
        minItems, maxItems, tiers, qbTiers,
      }) !==
      JSON.stringify({
        ...initialForm,
        packages: stripCollectionPoolItems(initialForm.packages),
      }),
    [
      initialForm, title, type, status, pricingType, pricingValue,
      widgetStyle, widgetHeading, accentColor, showPrices, skipCart, autoCheckout,
      poolMode, itemSubtextTemplate, showSubtextOnGifts, freeShipping, translations,
      items, packages, collections,
      collectionPoolItems, poolSource,
      minItems, maxItems, tiers, qbTiers,
    ],
  );

  // Shared by discard() (reset to the last-loaded state) and the post-save
  // resync below (adopt the freshly-saved state, e.g. server-assigned ids for
  // pack sizes/packages created in this session) — both are "make local
  // editor state match a `formStateOf(...)` snapshot exactly."
  // resetActiveTabs is false for the post-save resync so the user isn't
  // knocked back to the first package/pack-size tab right after saving.
  const applyFormState = useCallback(
    (form: ReturnType<typeof formStateOf>, resetActiveTabs: boolean) => {
      setTitle(form.title);
      setType(form.type);
      setStatus(form.status);
      setPricingType(form.pricingType);
      setPricingValue(form.pricingValue);
      setWidgetStyle(form.widgetStyle);
      setWidgetHeading(form.widgetHeading);
      setAccentColor(form.accentColor);
      setShowPrices(form.showPrices);
      setSkipCart(form.skipCart);
      setAutoCheckout(form.autoCheckout);
      setPoolMode(form.poolMode);
      setItemSubtextTemplate(form.itemSubtextTemplate);
      setShowSubtextOnGifts(form.showSubtextOnGifts);
      setFreeShipping(form.freeShipping);
      setTranslations(form.translations);
      setItems(form.items);
      setPackages(form.packages);
      if (resetActiveTabs) setActivePackageIndex(0);
      setCollections(form.collections);
      setPoolSource(form.poolSource);
      setMinItems(form.minItems);
      setMaxItems(form.maxItems);
      setTiers(form.tiers);
      setQbTiers(form.qbTiers);
      if (resetActiveTabs) setActiveQbTierIndex(0);
    },
    [],
  );

  const discard = useCallback(() => {
    applyFormState(initialForm, true);
  }, [initialForm, applyFormState]);
  const errors = fetcher.data && "errors" in fetcher.data ? fetcher.data.errors : null;

  const lastHandledSaveRef = useRef<typeof fetcher.data | null>(null);
  const justSavedRef = useRef(false);
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data &&
      "saved" in fetcher.data &&
      fetcher.data !== lastHandledSaveRef.current
    ) {
      lastHandledSaveRef.current = fetcher.data;
      shopify.toast.show("Bundle saved");
      justSavedRef.current = true;
      revalidator.revalidate();
    }
  }, [fetcher.state, fetcher.data, shopify, revalidator]);

  // Revalidating after a save re-fetches the bundle with server-assigned ids
  // for anything created in this session (new packages, new pack-size
  // tiers) — without this, local state keeps its id-less/temp-keyed copies,
  // which never matches the freshly-loaded `initialForm` and leaves the
  // save bar stuck open right after a successful save. Also covers the
  // create flow, where the redirect to the new bundle's URL swaps `bundle`
  // from null to the created record without remounting this component.
  const prevBundleRef = useRef(bundle);
  useEffect(() => {
    const justCreated = prevBundleRef.current === null && bundle !== null;
    if ((justSavedRef.current || justCreated) && bundle !== prevBundleRef.current) {
      justSavedRef.current = false;
      applyFormState(formStateOf(bundle, requestedType), false);
    }
    prevBundleRef.current = bundle;
  }, [bundle, requestedType, applyFormState]);

  const openResourcePicker = useCallback(async (isGiftFlag: boolean) => {
    // Fixed bundles are variant-level: preselect the exact variants so the
    // picker shows them checked, and each selected variant becomes its own
    // line item. Pool types stay product-level. Scoped to the matching
    // group (paid vs. gift) so picking gifts doesn't preselect/overwrite
    // the paid component list, and vice versa.
    // SLOT_BUILDER gifts are variant-level too (same as FIXED); its pool add
    // stays product-level like MIX_MATCH/QUANTITY_BREAKS (a slot is filled
    // by whichever variant the customer picks at checkout, not pinned by the
    // merchant here) — both read/write activeItems exactly like FIXED does.
    const useVariantPicker = type === "FIXED" || (type === "SLOT_BUILDER" && isGiftFlag);
    const groupItems = activeItems.filter((i) => i.isGift === isGiftFlag);
    const selectionIds = useVariantPicker
      ? Array.from(
            groupItems.reduce((byProduct, item) => {
              if (item.variantId) {
                const entry = byProduct.get(item.productId) ?? {
                  id: item.productId,
                  variants: [] as { id: string }[],
                };
                entry.variants.push({ id: item.variantId });
                byProduct.set(item.productId, entry);
              } else {
                byProduct.set(item.productId, { id: item.productId, variants: [] });
              }
              return byProduct;
            }, new Map<string, { id: string; variants: { id: string }[] }>()),
            ([, entry]) =>
              entry.variants.length > 0 ? entry : { id: entry.id },
          )
        : groupItems.map((i) => ({ id: i.productId }));

    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "add",
      selectionIds,
      filter: {
        // Only active products are purchasable in a bundle, so hide drafts
        // and archived products from the picker.
        draft: false,
        archived: false,
        // QUANTITY_BREAKS applies across every variant of a product — there's
        // nothing to pick at the variant level, so hide that UI entirely.
        ...(type === "QUANTITY_BREAKS" ? { variants: false } : {}),
      },
    });
    if (!selection) return;

    const toPrice = (raw: unknown) => {
      const price = parseFloat(String(raw));
      return Number.isNaN(price) ? null : price;
    };

    if (useVariantPicker) {
      setActiveItems((current) => {
        // Scoped to the same group so an existing paid item isn't reused
        // (with the wrong isGift flag) when adding to the gift group, or
        // vice versa.
        const byVariant = new Map(
          current
            .filter((i) => i.isGift === isGiftFlag)
            .map((i) => [i.variantId ?? i.productId, i]),
        );
        const newGroupItems = selection.flatMap((product: any) => {
          const variants: any[] = product.variants?.length
            ? product.variants
            : [null];
          return variants.map((variant) => {
            const existing = byVariant.get(variant?.id ?? product.id);
            if (existing) return existing;
            const hasRealTitle =
              variant?.title && variant.title !== "Default Title";
            return {
              productId: product.id,
              variantId: variant?.id ?? null,
              productTitle: hasRealTitle
                ? `${product.title} — ${variant.title}`
                : product.title,
              productImageUrl:
                variant?.image?.originalSrc ??
                product.images?.[0]?.originalSrc ??
                null,
              quantity: 1,
              isGift: isGiftFlag,
              price: toPrice(variant?.price),
              missing: false,
            };
          });
        });
        return [...current.filter((i) => i.isGift !== isGiftFlag), ...newGroupItems];
      });
      return;
    }

    // Product-level pool add: MIX_MATCH/QUANTITY_BREAKS write the bundle-wide
    // `items` list; SLOT_BUILDER writes the package pool instead (via
    // setPoolItems, which also fans out to every package under a GLOBAL
    // pool), scoped past its gift entries so re-adding a product already
    // picked as a gift doesn't reuse/overwrite that row.
    // QUANTITY_BREAKS applies across every variant of the product — never
    // pin to one, so it stays a single product-level row regardless of which
    // variants the picker shows as checked. MIX_MATCH/SLOT_BUILDER add
    // whichever specific variant(s) the merchant checked in the picker —
    // one pool row per checked variant, not just the first.
    const setter = type === "SLOT_BUILDER" ? setPoolItems : setItems;
    setter((current) => {
      const relevant = type === "SLOT_BUILDER" ? current.filter((i) => !i.isGift) : current;
      const byKey = new Map(relevant.map((i) => [i.variantId ?? i.productId, i]));
      const newItems = selection.flatMap((product: any) => {
        if (type === "QUANTITY_BREAKS") {
          const existing = byKey.get(product.id);
          if (existing) return [existing];
          return [
            {
              productId: product.id,
              variantId: null,
              productTitle: product.title,
              productImageUrl: product.images?.[0]?.originalSrc ?? null,
              quantity: 1,
              isGift: false,
              price: toPrice(product.variants?.[0]?.price),
              missing: false,
            },
          ];
        }
        const variants: any[] = product.variants?.length ? product.variants : [null];
        return variants.map((variant) => {
          const existing = byKey.get(variant?.id ?? product.id);
          if (existing) return existing;
          const hasRealVariantTitle = variant?.title && variant.title !== "Default Title";
          return {
            productId: product.id,
            variantId: variant?.id ?? null,
            productTitle: hasRealVariantTitle ? `${product.title} — ${variant.title}` : product.title,
            productImageUrl:
              variant?.image?.originalSrc ?? product.images?.[0]?.originalSrc ?? null,
            quantity: 1,
            isGift: false,
            price: toPrice(variant?.price),
            missing: false,
          };
        });
      });
      return type === "SLOT_BUILDER" ? [...current.filter((i) => i.isGift), ...newItems] : newItems;
    });
  }, [shopify, activeItems, type, setActiveItems, setPoolItems]);

  const openCollectionPicker = useCallback(async () => {
    const selection = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      action: "add",
      selectionIds: activeCollections.map((c) => ({ id: c.id })),
    });
    if (!selection) return;
    setActiveCollections(() =>
      selection.map((collection: any) => ({
        id: collection.id,
        title: collection.title,
        imageUrl: collection.image?.originalSrc ?? null,
      })),
    );
  }, [shopify, activeCollections, setActiveCollections]);

  const addQbTier = useCallback(() => {
    setQbTiers((current) => [
      ...current,
      {
        tempKey: `new-${Date.now()}`,
        quantity: "",
        label: "",
        badgeText: "",
        badgeTone: "",
        pricingType: "PERCENT_OFF",
        pricingValue: "",
        isDefault: current.length === 0,
        items: [],
      },
    ]);
  }, []);

  const updateQbTier = useCallback((tempKey: string, patch: Partial<QbTierState>) => {
    setQbTiers((current) =>
      current.map((t) => (t.tempKey === tempKey ? { ...t, ...patch } : t)),
    );
  }, []);

  const removeQbTier = useCallback((tempKey: string) => {
    setQbTiers((current) => current.filter((t) => t.tempKey !== tempKey));
  }, []);

  const setQbTierDefault = useCallback((tempKey: string) => {
    setQbTiers((current) => current.map((t) => ({ ...t, isDefault: t.tempKey === tempKey })));
  }, []);

  const openQbTierGiftPicker = useCallback(
    async (tempKey: string) => {
      const tier = qbTiers.find((t) => t.tempKey === tempKey);
      const existingItems = tier?.items ?? [];
      const selection = await shopify.resourcePicker({
        type: "product",
        multiple: true,
        action: "add",
        selectionIds: existingItems.map((i) =>
          i.variantId ? { id: i.productId, variants: [{ id: i.variantId }] } : { id: i.productId },
        ),
        filter: {
          // Only active products are purchasable in a bundle, so hide drafts
          // and archived products from the picker.
          draft: false,
          archived: false,
        },
      });
      if (!selection) return;

      const toPrice = (raw: unknown) => {
        const price = parseFloat(String(raw));
        return Number.isNaN(price) ? null : price;
      };

      setQbTiers((current) =>
        current.map((t) => {
          if (t.tempKey !== tempKey) return t;
          const byKey = new Map(t.items.map((i) => [i.variantId ?? i.productId, i]));
          const newItems = selection.flatMap((product: any) => {
            const variants: any[] = product.variants?.length ? product.variants : [null];
            return variants.map((variant) => {
              const existing = byKey.get(variant?.id ?? product.id);
              if (existing) return existing;
              const hasRealTitle = variant?.title && variant.title !== "Default Title";
              return {
                productId: product.id,
                variantId: variant?.id ?? null,
                productTitle: hasRealTitle ? `${product.title} — ${variant.title}` : product.title,
                productImageUrl: variant?.image?.originalSrc ?? product.images?.[0]?.originalSrc ?? null,
                quantity: 1,
                isGift: true,
                price: toPrice(variant?.price),
                missing: false,
              };
            });
          });
          return { ...t, items: newItems };
        }),
      );
    },
    [shopify, qbTiers],
  );

  const removeQbTierItem = useCallback((tempKey: string, key: string) => {
    setQbTiers((current) =>
      current.map((t) =>
        t.tempKey === tempKey
          ? { ...t, items: t.items.filter((i) => (i.variantId ?? i.productId) !== key) }
          : t,
      ),
    );
  }, []);

  const editBundleProduct = useCallback(async () => {
    const productId = bundle?.shopifyProductId;
    if (!productId) return;
    // Intents API opens Shopify's native product editor in a modal over the
    // app; not yet in app-bridge-react types, and absent on older admin builds
    const intents = (shopify as unknown as {
      intents?: {
        invoke: (
          intent: string,
          options: { value: string },
        ) => Promise<{ complete: Promise<{ code: string }> }>;
      };
    }).intents;
    if (!intents) {
      open(`shopify://admin/products/${productId.split("/").pop()}`, "_top");
      return;
    }
    const activity = await intents.invoke("edit:shopify/Product", {
      value: productId,
    });
    await activity.complete;
    revalidator.revalidate();
  }, [shopify, bundle, revalidator]);

  /* Re-links a bundle to a product that already exists, instead of leaving
     the merchant to delete the orphan and let the next save build a duplicate.
     See the picker's own filter below for why it's scoped the way it is. */
  const connectExistingProduct = useCallback(async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      action: "select",
      filter: {
        // Product level only. The bundle owns this product's variants — one
        // per package, created and repriced on every publish — so picking a
        // variant here would imply a choice that doesn't exist, and whichever
        // one was picked would be ignored.
        variants: false,
        // Draft and archived stay pickable, unlike the pool pickers: the
        // product being reconnected is usually the bundle's own orphan, and
        // that's exactly the thing a merchant is likely to have drafted or
        // archived while working out what went wrong.
      },
      ...(bundle?.shopifyProductId
        ? { selectionIds: [{ id: bundle.shopifyProductId }] }
        : {}),
    });
    const picked = selection?.[0];
    if (!picked) return;
    connectFetcher.submit(
      { intent: "connect-product", productId: picked.id },
      { method: "POST" },
    );
  }, [shopify, bundle, connectFetcher]);

  // The loader carries the linked product, so the card can only show the new
  // link once the route's data is refetched.
  useEffect(() => {
    const data = connectFetcher.data;
    if (connectFetcher.state !== "idle" || !data) return;
    // `in` rather than optional chaining: the action returns several different
    // shapes (save errors, duplicate, connect) and TypeScript only sees their
    // union here, so the key has to be narrowed before it can be read.
    if ("connected" in data && data.connected) {
      shopify.toast.show("Product connected — save to finish linking it");
      revalidator.revalidate();
    } else if ("errors" in data && data.errors?.length) {
      shopify.toast.show(data.errors[0], { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectFetcher.state, connectFetcher.data]);

  const onCopyBundleId = useCallback(() => {
    if (!bundle) return;
    navigator.clipboard.writeText(bundle.id);
    shopify.toast.show("Bundle ID copied");
  }, [shopify, bundle]);

  const save = useCallback(() => {
    /* GLOBAL pool: every package is saved carrying the same pool definition,
       so the rows that reach the DB — and from there the app proxy, the
       display metafield and the Cart Transform — are indistinguishable from a
       merchant who set the same pool on each package by hand. That's the
       whole point of fanning out here rather than storing the pool once:
       nothing downstream has to learn about the mode.

       The editor already keeps the packages in sync as they're edited; this
       is the belt-and-braces copy so a package that somehow drifted can't
       smuggle a divergent pool through. Gifts are explicitly NOT shared —
       they stay whatever each package defines. */
    const isGlobalPoolSave = type === "SLOT_BUILDER" && poolMode === "GLOBAL";
    const poolTemplate = packages[0];
    const packagesToSave =
      isGlobalPoolSave && poolTemplate
        ? packages.map((pkg) => ({
            ...pkg,
            poolSource: poolTemplate.poolSource,
            collections: poolTemplate.collections,
            variantFilter: poolTemplate.variantFilter,
            tagFilters: poolTemplate.tagFilters,
            items: [
              ...pkg.items.filter((i) => i.isGift),
              ...poolTemplate.items.filter((i) => !i.isGift),
            ],
          }))
        : packages;

    // SLOT_BUILDER's pool lives per-package now, not at the bundle level —
    // its own collectionIds/items are resolved per package below instead.
    const usesCollections = type !== "FIXED" && type !== "SLOT_BUILDER" && poolSource === "COLLECTIONS";
    // QUANTITY_BREAKS only — every other type only ever has PRODUCTS/COLLECTIONS
    const usesAllProducts = type === "QUANTITY_BREAKS" && poolSource === "ALL";
    const collectionIds = usesCollections ? collections.map((c) => c.id) : [];
    const payload = {
      title,
      description,
      type,
      status,
      pricingType,
      pricingValue: parseFloat(pricingValue) || 0,
      widgetStyle,
      widgetHeading,
      accentColor,
      showPrices,
      skipCart,
      // Enforced here as well as by the disabled checkbox: the widget's own
      // button only exists when skipCart is on, so auto checkout has nothing
      // to drive without it.
      autoCheckout: skipCart && autoCheckout,
      // Authoring-only, and only Build a box offers the choice.
      poolMode: type === "SLOT_BUILDER" ? poolMode : "PER_PACKAGE",
      itemSubtextTemplate,
      showSubtextOnGifts,
      freeShipping,
      quantityBreakScope: poolSource,
      // Only Build a Box renders a translatable widget — every other type
      // would just be carrying dead copy around.
      translations: type === "SLOT_BUILDER" ? translations : {},
      // price/missing are editor-only display state — the DB schema doesn't store them
      items:
        type === "FIXED" || type === "SLOT_BUILDER" || usesCollections || usesAllProducts
          ? []
          : items.map(({ price: _price, missing: _missing, ...item }) => item),
      tiers:
        type === "QUANTITY_BREAKS"
          ? qbTiers.map((tier, position) => ({
              id: tier.id,
              quantity: parseInt(tier.quantity, 10) || 0,
              label: tier.label.trim() || `Tier ${position + 1}`,
              badgeText: tier.badgeText.trim() || null,
              badgeTone: tier.badgeTone || null,
              pricingType: tier.pricingType,
              pricingValue: parseFloat(tier.pricingValue) || 0,
              isDefault: tier.isDefault,
              position,
              // price/missing/isGift are editor-only display state — the DB
              // schema doesn't store them (tier items are always free gifts)
              items: tier.items.map(
                ({ price: _price, missing: _missing, isGift: _isGift, ...item }, itemPosition) => ({
                  ...item,
                  position: itemPosition,
                }),
              ),
            }))
          : [],
      packages:
        type === "FIXED" || type === "SLOT_BUILDER"
          ? packagesToSave.map((pkg, position) => {
              // Each SLOT_BUILDER package has its own pool source — only
              // send collectionIds/items for whichever one it's actually
              // using, same convention as the bundle-wide pool below.
              const pkgUsesCollections = type === "SLOT_BUILDER" && pkg.poolSource === "COLLECTIONS";
              return {
                id: pkg.id,
                label: pkg.label,
                badgeText: pkg.badgeText.trim() || null,
                badgeTone: pkg.badgeTone || null,
                position,
                pricingType: pkg.pricingType,
                pricingValue: parseFloat(pkg.pricingValue) || 0,
                freeShipping: pkg.freeShipping,
                poolSource: type === "SLOT_BUILDER" ? pkg.poolSource : "PRODUCTS",
                slotCount: type === "SLOT_BUILDER" ? parseInt(pkg.slotCount, 10) || 0 : 0,
                collectionIds: pkgUsesCollections ? pkg.collections.map((c) => c.id) : [],
                variantFilter: pkgUsesCollections ? pkg.variantFilter.trim() : "",
                // Rows with either field blank are still being typed — drop
                // them rather than saving a chip that can't render/match.
                tagFilters:
                  type === "SLOT_BUILDER"
                    ? pkg.tagFilters
                        .map((f) => ({ label: f.label.trim(), tag: f.tag.trim() }))
                        .filter((f) => f.label && f.tag)
                    : [],
                translations: type === "SLOT_BUILDER" ? (pkg.translations ?? {}) : {},
                // Pool items (isGift: false) aren't sent when this package's
                // pool is collection-sourced — only its free gifts are.
                items: (pkgUsesCollections ? pkg.items.filter((i) => i.isGift) : pkg.items).map(
                  ({ price: _price, missing: _missing, ...item }) => item,
                ),
              };
            })
          : [],
      // SLOT_BUILDER no longer needs a bundle-level rule — slot count and
      // pool now live per package instead (see `packages` above).
      rule:
        type === "MIX_MATCH"
          ? {
              minItems: parseInt(minItems, 10) || 1,
              maxItems: maxItems ? parseInt(maxItems, 10) : null,
              discountTiers: tiers
                .map((t) => ({
                  quantity: parseInt(t.quantity, 10) || 0,
                  discount: parseFloat(t.discount) || 0,
                }))
                .filter((t) => t.quantity > 0 && t.discount > 0),
              collectionIds,
            }
          : type === "QUANTITY_BREAKS" && usesCollections
            ? { minItems: 1, maxItems: null, discountTiers: [], collectionIds }
            : null,
    };
    fetcher.submit(
      { payload: JSON.stringify(payload) },
      { method: "POST" },
    );
  }, [
    fetcher, title, description, type, status, pricingType, pricingValue,
    widgetStyle, widgetHeading, accentColor, showPrices, skipCart, autoCheckout,
    poolMode, itemSubtextTemplate, showSubtextOnGifts, freeShipping, translations, items,
    packages, minItems, maxItems,
    tiers, poolSource, collections, qbTiers,
  ]);

  // Mirrors the compare-at math in publishFixedBundleProduct/
  // publishSlotBuilderBundleProduct so merchants see exactly what will be
  // set on the bundle product. FIXED's paidItems are the bundle's actual
  // contents, so their prices sum directly. SLOT_BUILDER's paidItems are its
  // *pool* — the customer only gets `slotCount` of them, not all of them —
  // so the comparable "buy these separately" price is the pool's average
  // item price times the slot count instead. Only computable when the pool
  // is PRODUCTS-sourced (a COLLECTIONS pool has no priced items loaded
  // client-side), same as paidItems being empty for FIXED with no items yet.
  const combinedPrice = useMemo(() => {
    if (type === "SLOT_BUILDER") {
      const priced = paidItems.filter((i) => i.price != null);
      const slots = parseInt(packages[activePackageIndex]?.slotCount ?? "0", 10) || 0;
      if (priced.length === 0 || slots === 0) return 0;
      const average = priced.reduce((sum, i) => sum + (i.price ?? 0), 0) / priced.length;
      return Math.round(average * slots * 100) / 100;
    }
    return (
      Math.round(paidItems.reduce((sum, i) => sum + (i.price ?? 0) * i.quantity, 0) * 100) / 100
    );
  }, [type, paidItems, packages, activePackageIndex]);
  const hasMissingPrices = activeItems.some((i) => i.price == null);
  const computedBundlePrice = useMemo(() => {
    const value = parseFloat(activePricingValue) || 0;
    let price: number;
    if (activePricingType === "FIXED_PRICE") price = value;
    else if (activePricingType === "PERCENT_OFF") price = combinedPrice * (1 - value / 100);
    else price = combinedPrice - value;
    return Math.max(0, Math.round(price * 100) / 100);
  }, [activePricingType, activePricingValue, combinedPrice]);
  const pricingValueError =
    activePricingType === "PERCENT_OFF" && (parseFloat(activePricingValue) || 0) > 100
      ? "Discount can't be more than 100%."
      : (parseFloat(activePricingValue) || 0) < 0
        ? "Value can't be negative."
        : undefined;
  const savings = Math.round((combinedPrice - computedBundlePrice) * 100) / 100;

  const showCollectionPool = type !== "FIXED" && activePoolSource === "COLLECTIONS";
  // QUANTITY_BREAKS only — every other type only ever has PRODUCTS/COLLECTIONS
  const showAllProductsNotice = type === "QUANTITY_BREAKS" && activePoolSource === "ALL";

  // Which sections exist depends on the bundle type, and the type can change
  // in-session on an unsaved bundle. Resolved rather than stored so a section
  // that stops existing falls back to the first one on the same render — an
  // effect would leave one frame showing nothing.
  const sections = useMemo(() => editorSectionsFor(type), [type]);
  const activeSection = sections.some((s) => s.id === selectedSection)
    ? selectedSection
    : sections[0].id;
  // Pricing, products and gifts are all per-package, so those sections repeat
  // the package tab strip for context (it hides itself below two packages).
  const isMultiPackageType = type === "FIXED" || type === "SLOT_BUILDER";

  return (
    <Page
      backAction={{ content: "Home", url: "/app" }}
      title={isNew ? "Create bundle" : title || "Edit bundle"}
      titleMetadata={
        status === "ACTIVE" ? <Badge tone="success">Active</Badge> : <Badge>Draft</Badge>
      }
      primaryAction={{
        content: "Preview bundle",
        disabled: !shopifyProduct?.previewUrl,
        onAction: () => {
          if (shopifyProduct?.previewUrl) open(shopifyProduct.previewUrl, "_blank");
        },
      }}
      secondaryActions={
        isNew
          ? []
          : [
              {
                content: "Duplicate",
                loading: duplicateFetcher.state !== "idle",
                // Unsaved edits stay behind: the copy is made from what's in
                // the database, so the save bar's warning about leaving is
                // the right guard rather than silently copying stale values.
                onAction: () =>
                  duplicateFetcher.submit({ intent: "duplicate" }, { method: "POST" }),
              },
              {
                content: "Delete",
                destructive: true,
                loading: deleteFetcher.state !== "idle",
                onAction: () =>
                  deleteFetcher.submit({ intent: "delete" }, { method: "POST" }),
              },
            ]
      }
    >
      <TitleBar title={isNew ? "Create bundle" : "Edit bundle"} />
      <SaveBar id="bundle-save-bar" open={isDirty || isSaving}>
        <button
          variant="primary"
          onClick={save}
          loading={isSaving ? "" : undefined}
        >
          Save
        </button>
        <button onClick={discard} disabled={isSaving}>
          Discard
        </button>
      </SaveBar>
      <BlockStack gap="500">
        {errors && (
          <Banner tone="critical" title="Couldn't save bundle">
            <ul style={{ margin: 0, paddingLeft: "1rem" }}>
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </Banner>
        )}

        {(type === "FIXED" || type === "SLOT_BUILDER"
          ? packages.some((pkg) => pkg.items.some((i) => i.missing))
          : items.some((i) => i.missing)) && (
          <Banner tone="critical" title="Some products no longer exist">
            <p>
              Products marked &quot;Deleted from store&quot; were removed from
              your Shopify catalog but are still part of this bundle, which
              breaks checkout for it. Remove them below and save the bundle.
            </p>
          </Banner>
        )}

        <Layout>
          {/* Sidebar first: Layout renders sections in source order, so this
              puts the narrow column on the left — and makes it the first
              thing on mobile, where the two columns stack. */}
          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <PublishingCard
                type={type}
                shopCurrency={shopCurrency}
                status={status}
                setStatus={setStatus}
                isNew={isNew}
                bundleId={bundle?.id}
                shopifyProductId={bundle?.shopifyProductId}
                shopifyProduct={shopifyProduct}
                editBundleProduct={editBundleProduct}
                onCopyBundleId={onCopyBundleId}
                connectExistingProduct={connectExistingProduct}
                isConnecting={connectFetcher.state !== "idle"}
              />
              <EditorNav
                sections={sections}
                activeSection={activeSection}
                onSelect={setSelectedSection}
              />
            </BlockStack>
          </Layout.Section>

          <Layout.Section>
            <BlockStack gap="400">
              {activeSection === "general" && (
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Details
                    </Text>
                    <TextField
                      label="Title"
                      value={title}
                      onChange={setTitle}
                      autoComplete="off"
                      placeholder="e.g. Summer Essentials Kit"
                    />
                  </BlockStack>
                </Card>
              )}

              {activeSection === "general" && isMultiPackageType && (
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        Packages
                      </Text>
                      <Tooltip
                        content={
                          canAddPackage
                            ? undefined
                            : "Packages can't be added once this bundle has been published to Shopify. Remove or edit existing packages instead."
                        }
                      >
                        <Button icon={PlusIcon} onClick={addPackage} disabled={!canAddPackage}>
                          Add package
                        </Button>
                      </Tooltip>
                    </InlineStack>
                    <PackagesTabsSection
                      packages={packages}
                      activePackageIndex={activePackageIndex}
                      setActivePackageIndex={setActivePackageIndex}
                      updateActivePackage={updateActivePackage}
                      removeActivePackage={removeActivePackage}
                    />
                    <Divider />
                    {/* Pricing is always per package here — this section only
                        renders for the two types that have packages. */}
                    {type === "SLOT_BUILDER" ? (
                      <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                        <PricingSection
                          type={type}
                          shopCurrency={shopCurrency}
                          activePricingType={activePricingType}
                          activePricingValue={activePricingValue}
                          onPricingTypeChange={(value) =>
                            updateActivePackage({ pricingType: value })
                          }
                          onPricingValueChange={(value) =>
                            updateActivePackage({ pricingValue: value })
                          }
                          pricingValueError={pricingValueError}
                        />
                        <BlockStack gap="400">
                          <Text as="h2" variant="headingMd">
                            Slots
                          </Text>
                          <TextField
                            label="Number of slots"
                            type="number"
                            min={2}
                            value={packages[activePackageIndex]?.slotCount ?? "2"}
                            onChange={(value) => updateActivePackage({ slotCount: value })}
                            autoComplete="off"
                            helpText="Customers fill every slot in this package to complete the bundle."
                          />
                        </BlockStack>
                      </InlineGrid>
                    ) : (
                      <PricingSection
                        type={type}
                        shopCurrency={shopCurrency}
                        activePricingType={activePricingType}
                        activePricingValue={activePricingValue}
                        onPricingTypeChange={(value) =>
                          updateActivePackage({ pricingType: value })
                        }
                        onPricingValueChange={(value) =>
                          updateActivePackage({ pricingValue: value })
                        }
                        pricingValueError={pricingValueError}
                      />
                    )}
                    <PricingSummaryBox
                      type={type}
                      shopCurrency={shopCurrency}
                      paidItems={paidItems}
                      combinedPrice={combinedPrice}
                      computedBundlePrice={computedBundlePrice}
                      savings={savings}
                      hasMissingPrices={hasMissingPrices}
                    />
                  </BlockStack>
                </Card>
              )}

              {activeSection === "products" && (
                <Card>
                  <BlockStack gap="400">
                    {/* The pool-mode choice leads the section: it decides
                        whether the package tabs below it appear at all. */}
                    {type === "SLOT_BUILDER" && packages.length > 1 && (
                      <PoolModeSelector
                        poolMode={poolMode}
                        setPoolMode={onPoolModeChange}
                      />
                    )}
                    {/* No tabs under a GLOBAL pool — there's one pool, so
                        switching packages here would imply otherwise. */}
                    {isMultiPackageType && !isGlobalPool && (
                      <PackageTabsStrip
                        packages={packages}
                        activePackageIndex={activePackageIndex}
                        setActivePackageIndex={setActivePackageIndex}
                      />
                    )}
                    {/* Build a box scopes its pool to the active package (or
                        shares one across them); every other type keeps one
                        bundle-wide list. */}
                    {type === "SLOT_BUILDER" ? (
                      <ProductsSection
                        type={type}
                        shopCurrency={shopCurrency}
                        poolSource={activePoolSource}
                        setPoolSource={setActivePoolSource}
                        showCollectionPool={showCollectionPool}
                        showAllProductsNotice={showAllProductsNotice}
                        collections={activeCollections}
                        setCollections={setActiveCollections}
                        collectionPoolItems={activeCollectionPoolItems}
                        variantFilter={activeVariantFilter}
                        setVariantFilter={setActiveVariantFilter}
                        tagFilters={activeTagFilters}
                        setTagFilters={setActiveTagFilters}
                        onResolveProducts={resolveActivePoolProducts}
                        isResolvingPool={isResolvingPool}
                        paidItems={paidItems}
                        setActiveItems={setPoolItems}
                        openResourcePicker={openResourcePicker}
                        openCollectionPicker={openCollectionPicker}
                      />
                    ) : (
                      <ProductsSection
                        type={type}
                        shopCurrency={shopCurrency}
                        poolSource={poolSource}
                        setPoolSource={setPoolSource}
                        showCollectionPool={showCollectionPool}
                        showAllProductsNotice={showAllProductsNotice}
                        collections={collections}
                        setCollections={setCollections}
                        collectionPoolItems={collectionPoolItems}
                        paidItems={paidItems}
                        setActiveItems={setActiveItems}
                        openResourcePicker={openResourcePicker}
                        openCollectionPicker={openCollectionPicker}
                      />
                    )}
                  </BlockStack>
                </Card>
              )}

              {activeSection === "gifts" && isMultiPackageType && (
                <Card>
                  <BlockStack gap="400">
                    <PackageTabsStrip
                      packages={packages}
                      activePackageIndex={activePackageIndex}
                      setActivePackageIndex={setActivePackageIndex}
                    />
                    {/* inherited* are empty for FIXED by construction, so they
                        pass through unconditionally — only the progressive
                        unlock behaviour is Build-a-box specific. */}
                    <GiftsSection
                      giftItems={giftItems}
                      setActiveItems={setActiveItems}
                      openResourcePicker={openResourcePicker}
                      freeShipping={packages[activePackageIndex]?.freeShipping ?? false}
                      onFreeShippingChange={(checked) =>
                        updateActivePackage({ freeShipping: checked })
                      }
                      progressive={type === "SLOT_BUILDER"}
                      inheritedGiftItems={inheritedGiftItems}
                      inheritedFreeShipping={inheritedFreeShipping}
                    />
                  </BlockStack>
                </Card>
              )}

              {activeSection === "tiers" && (
                <Card>
                  <QuantityBreaksTiersSection
                    shopCurrency={shopCurrency}
                    qbTiers={qbTiers}
                    activeQbTierIndex={activeQbTierIndex}
                    setActiveQbTierIndex={setActiveQbTierIndex}
                    addQbTier={addQbTier}
                    updateQbTier={updateQbTier}
                    removeQbTier={removeQbTier}
                    setQbTierDefault={setQbTierDefault}
                    openQbTierGiftPicker={openQbTierGiftPicker}
                    removeQbTierItem={removeQbTierItem}
                  />
                </Card>
              )}

              {activeSection === "widget" && (
                <Card>
                  <QuantityBreaksWidgetSection
                    widgetHeading={widgetHeading}
                    setWidgetHeading={setWidgetHeading}
                    accentColor={accentColor}
                    setAccentColor={setAccentColor}
                  />
                </Card>
              )}

              {activeSection === "rules" && (
                <Card>
                  <MixMatchRulesSection
                    minItems={minItems}
                    setMinItems={setMinItems}
                    maxItems={maxItems}
                    setMaxItems={setMaxItems}
                    tiers={tiers}
                    setTiers={setTiers}
                  />
                </Card>
              )}

              {activeSection === "appearance" && (
                <Card>
                  <StorefrontSection
                    type={type}
                    widgetStyle={widgetStyle}
                    setWidgetStyle={setWidgetStyle}
                    accentColor={accentColor}
                    setAccentColor={setAccentColor}
                    widgetHeading={widgetHeading}
                    setWidgetHeading={setWidgetHeading}
                    showPrices={showPrices}
                    setShowPrices={setShowPrices}
                    itemSubtextTemplate={itemSubtextTemplate}
                    setItemSubtextTemplate={setItemSubtextTemplate}
                    showSubtextOnGifts={showSubtextOnGifts}
                    setShowSubtextOnGifts={setShowSubtextOnGifts}
                    skipCart={skipCart}
                    setSkipCart={onSkipCartChange}
                    autoCheckout={autoCheckout}
                    setAutoCheckout={setAutoCheckout}
                  />
                </Card>
              )}

              {activeSection === "translations" && (
                <Card>
                  <TranslationsSection
                    locales={shopLocales}
                    translations={translations}
                    setTranslations={setTranslations}
                    widgetHeading={widgetHeading}
                    packages={packages}
                    updatePackage={updatePackageAt}
                  />
                </Card>
              )}
            </BlockStack>
          </Layout.Section>
        </Layout>

        {/* Breathing room below the last card; credit text can live here later */}
        <Box paddingBlockEnd="1000" />
      </BlockStack>
    </Page>
  );
}
