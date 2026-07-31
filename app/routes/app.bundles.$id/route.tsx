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
import { currencySymbol } from "../../utils/money";
import {
  createBundle,
  deleteBundle,
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
import { PackagesTabsSection } from "./PackagesTabsSection";
import { QuantityBreaksTiersSection } from "./QuantityBreaksTiersSection";
import { QuantityBreaksWidgetSection } from "./QuantityBreaksWidgetSection";
import { MixMatchRulesSection } from "./MixMatchRulesSection";
import { AppearanceSection } from "./AppearanceSection";
import { TranslationsSection } from "./TranslationsSection";
import { PreviewSidebar } from "./PreviewSidebar";

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
      const primaryLocale =
        (await fetchShopLocales(admin)).find((l) => l.primary)?.locale ?? "en";
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

  // SLOT_BUILDER only: each package has its own product pool + slot count
  // (a "30ml" package can offer a different pool/slot count than "100ml"),
  // so poolSource/collections read/write the active package instead of the
  // bundle-wide state every other pool type (MIX_MATCH/QUANTITY_BREAKS) uses.
  const activePoolSource =
    type === "SLOT_BUILDER" ? (packages[activePackageIndex]?.poolSource ?? "PRODUCTS") : poolSource;
  const activeCollections =
    type === "SLOT_BUILDER" ? (packages[activePackageIndex]?.collections ?? []) : collections;
  const activeCollectionPoolItems =
    type === "SLOT_BUILDER"
      ? (packages[activePackageIndex]?.collectionPoolItems ?? [])
      : collectionPoolItems;
  // SLOT_BUILDER only — MIX_MATCH/QUANTITY_BREAKS don't offer this filter.
  const activeVariantFilter = packages[activePackageIndex]?.variantFilter ?? "";
  const setActiveVariantFilter = useCallback(
    (value: string) => updateActivePackage({ variantFilter: value }),
    [updateActivePackage],
  );
  // SLOT_BUILDER only: the active package's storefront pool-modal filter
  // chips (button text + product tag per row).
  const activeTagFilters = packages[activePackageIndex]?.tagFilters ?? [];
  const setActiveTagFilters = useCallback(
    (updater: (current: TagFilterState[]) => TagFilterState[]) =>
      setPackages((current) =>
        current.map((pkg, i) =>
          i === activePackageIndex ? { ...pkg, tagFilters: updater(pkg.tagFilters) } : pkg,
        ),
      ),
    [activePackageIndex],
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
      updateActivePackage({ collectionPoolItems: resolvePoolFetcher.data.items });
    }
    // Deliberately omits updateActivePackage so switching package tabs
    // doesn't re-apply a stale result to the newly active package.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvePoolFetcher.data, resolvePoolFetcher.state]);
  const setActivePoolSource = useCallback(
    (value: string) => {
      if (type === "SLOT_BUILDER") updateActivePackage({ poolSource: value });
      else setPoolSource(value);
    },
    [type, updateActivePackage],
  );
  const setActiveCollections = useCallback(
    (updater: (current: CollectionState[]) => CollectionState[]) => {
      if (type === "SLOT_BUILDER") {
        setPackages((current) =>
          current.map((pkg, i) =>
            i === activePackageIndex ? { ...pkg, collections: updater(pkg.collections) } : pkg,
          ),
        );
      } else {
        setCollections(updater);
      }
    },
    [type, activePackageIndex],
  );

  const addPackage = useCallback(() => {
    setPackages((current) => [
      ...current,
      { ...defaultPackageState(), tempKey: `new-${Date.now()}`, label: `Pack ${current.length + 1}` },
    ]);
  }, []);

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
        widgetHeading, accentColor, showPrices, skipCart, autoCheckout,
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
      itemSubtextTemplate, showSubtextOnGifts, freeShipping, translations, items,
      packages, collections,
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
    // `items` list; SLOT_BUILDER writes into the active package's list
    // instead (via setActiveItems), scoped past its gift entries so re-adding
    // a product already picked as a gift doesn't reuse/overwrite that row.
    // QUANTITY_BREAKS applies across every variant of the product — never
    // pin to one, so it stays a single product-level row regardless of which
    // variants the picker shows as checked. MIX_MATCH/SLOT_BUILDER add
    // whichever specific variant(s) the merchant checked in the picker —
    // one pool row per checked variant, not just the first.
    const setter = type === "SLOT_BUILDER" ? setActiveItems : setItems;
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
  }, [shopify, activeItems, type, setActiveItems]);

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

  const onCopyBundleId = useCallback(() => {
    if (!bundle) return;
    navigator.clipboard.writeText(bundle.id);
    shopify.toast.show("Bundle ID copied");
  }, [shopify, bundle]);

  const save = useCallback(() => {
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
          ? packages.map((pkg, position) => {
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
    itemSubtextTemplate, showSubtextOnGifts, freeShipping, translations, items, packages,
    minItems, maxItems,
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

  const currencySymbolText = useMemo(() => currencySymbol(shopCurrency), [shopCurrency]);
  const previewSummary = useMemo(() => {
    if (type === "QUANTITY_BREAKS") {
      const valid = qbTiers.filter((t) => t.quantity);
      if (valid.length === 0) return "Add pack sizes";
      return valid
        .map((t) => {
          const label = t.label.trim() || `${t.quantity} pack`;
          if (!t.pricingValue) return label;
          const priced =
            t.pricingType === "PERCENT_OFF"
              ? `${t.pricingValue}% off`
              : t.pricingType === "AMOUNT_OFF"
                ? `${currencySymbolText}${t.pricingValue} off`
                : `${currencySymbolText}${t.pricingValue} each`;
          return `${label} — ${priced}`;
        })
        .join(" · ");
    }
    if (type !== "MIX_MATCH") {
      if (activePricingType === "FIXED_PRICE")
        return activePricingValue
          ? `Bundle price: ${currencySymbolText}${activePricingValue}`
          : "Set a bundle price";
      if (activePricingType === "PERCENT_OFF")
        return activePricingValue ? `${activePricingValue}% off combined price` : "Set a discount";
      return activePricingValue
        ? `${currencySymbolText}${activePricingValue} off combined price`
        : "Set a discount";
    }
    const valid = tiers.filter((t) => t.quantity && t.discount);
    if (valid.length === 0) return "Add discount tiers";
    return valid
      .map((t) => `Buy ${t.quantity}+ → ${t.discount}% off`)
      .join(" · ");
  }, [type, activePricingType, activePricingValue, tiers, qbTiers, currencySymbolText]);

  const showCollectionPool = type !== "FIXED" && activePoolSource === "COLLECTIONS";
  // QUANTITY_BREAKS only — every other type only ever has PRODUCTS/COLLECTIONS
  const showAllProductsNotice = type === "QUANTITY_BREAKS" && activePoolSource === "ALL";

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
          <Layout.Section>
            <BlockStack gap="400">
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

              {type === "FIXED" ? (
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
                    <GiftsSection
                      giftItems={giftItems}
                      setActiveItems={setActiveItems}
                      openResourcePicker={openResourcePicker}
                      freeShipping={packages[activePackageIndex]?.freeShipping ?? false}
                      onFreeShippingChange={(checked) =>
                        updateActivePackage({ freeShipping: checked })
                      }
                    />
                    <Divider />
                    <PricingSection
                      type={type}
                      shopCurrency={shopCurrency}
                      activePricingType={activePricingType}
                      activePricingValue={activePricingValue}
                      onPricingTypeChange={(value) =>
                        type === "FIXED"
                          ? updateActivePackage({ pricingType: value })
                          : setPricingType(value)
                      }
                      onPricingValueChange={(value) =>
                        type === "FIXED"
                          ? updateActivePackage({ pricingValue: value })
                          : setPricingValue(value)
                      }
                      pricingValueError={pricingValueError}
                    />
                    <PricingSummaryBox
                      type={type}
                      shopCurrency={shopCurrency}
                      paidItems={paidItems}
                      combinedPrice={combinedPrice}
                      computedBundlePrice={computedBundlePrice}
                      savings={savings}
                      hasMissingPrices={hasMissingPrices}
                    />
                    <Divider />
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
                  </BlockStack>
                </Card>
              ) : type === "SLOT_BUILDER" ? (
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
                    <PricingSummaryBox
                      type={type}
                      shopCurrency={shopCurrency}
                      paidItems={paidItems}
                      combinedPrice={combinedPrice}
                      computedBundlePrice={computedBundlePrice}
                      savings={savings}
                      hasMissingPrices={hasMissingPrices}
                    />
                    <Divider />
                    <GiftsSection
                      giftItems={giftItems}
                      setActiveItems={setActiveItems}
                      openResourcePicker={openResourcePicker}
                      freeShipping={packages[activePackageIndex]?.freeShipping ?? false}
                      onFreeShippingChange={(checked) =>
                        updateActivePackage({ freeShipping: checked })
                      }
                      progressive
                      inheritedGiftItems={inheritedGiftItems}
                      inheritedFreeShipping={inheritedFreeShipping}
                    />
                    <Divider />
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
                      setActiveItems={setActiveItems}
                      openResourcePicker={openResourcePicker}
                      openCollectionPicker={openCollectionPicker}
                    />
                  </BlockStack>
                </Card>
              ) : (
                <>
                  <Card>
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
                  </Card>

                  {type === "QUANTITY_BREAKS" ? (
                    <>
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
                      <Card>
                        <QuantityBreaksWidgetSection
                          widgetHeading={widgetHeading}
                          setWidgetHeading={setWidgetHeading}
                          accentColor={accentColor}
                          setAccentColor={setAccentColor}
                        />
                      </Card>
                    </>
                  ) : (
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
                </>
              )}

              {(type === "FIXED" || type === "SLOT_BUILDER") && (
                <Card>
                  <AppearanceSection
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

              {/* Build a box is the only type with a translatable storefront
                  widget — the others render merchant copy the theme already
                  gets through Shopify's own translation tools. */}
              {type === "SLOT_BUILDER" && (
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

          <Layout.Section variant="oneThird">
            <PreviewSidebar
              type={type}
              shopCurrency={shopCurrency}
              title={title}
              description={description}
              status={status}
              setStatus={setStatus}
              showAllProductsNotice={showAllProductsNotice}
              showCollectionPool={showCollectionPool}
              collections={activeCollections}
              activeItems={type === "SLOT_BUILDER" ? paidItems : activeItems}
              itemCount={paidItems.length}
              previewSummary={previewSummary}
              minItems={minItems}
              maxItems={maxItems}
              slotCount={packages[activePackageIndex]?.slotCount ?? ""}
              isNew={isNew}
              bundleId={bundle?.id}
              shopifyProductId={bundle?.shopifyProductId}
              shopifyProduct={shopifyProduct}
              editBundleProduct={editBundleProduct}
              onCopyBundleId={onCopyBundleId}
            />
          </Layout.Section>
        </Layout>

        {/* Breathing room below the last card; credit text can live here later */}
        <Box paddingBlockEnd="1000" />
      </BlockStack>
    </Page>
  );
}
