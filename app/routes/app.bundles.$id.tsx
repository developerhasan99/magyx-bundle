import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  ChoiceList,
  Button,
  Thumbnail,
  Banner,
  Badge,
  Divider,
  Box,
} from "@shopify/polaris";
import { DeleteIcon, EditIcon, ImageIcon, PlusIcon } from "@shopify/polaris-icons";
import { SaveBar, TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  createBundle,
  deleteBundle,
  getBundle,
  updateBundle,
  type BundleInput,
} from "../models/bundle.server";
import {
  publishFixedBundleProduct,
  syncBundleConfigMetafield,
} from "../models/shopify-sync.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (params.id === "new") return { bundle: null, shopifyProduct: null };

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
  const itemVariantIds = bundle.items
    .map((i) => i.variantId)
    .filter((id): id is string => Boolean(id));
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

  // Resolve collection GIDs from the rule into titles/images for the editor UI
  let collections: { id: string; title: string; imageUrl: string | null }[] = [];
  const collectionIds: string[] = bundle.rule
    ? (JSON.parse(bundle.rule.collectionIds) as string[])
    : [];
  if (collectionIds.length > 0) {
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
        { variables: { ids: collectionIds } },
      );
      collections = ((await response.json()).data?.nodes ?? [])
        .filter(Boolean)
        .map((node: { id: string; title: string; image?: { url: string } | null }) => ({
          id: node.id,
          title: node.title,
          imageUrl: node.image?.url ?? null,
        }));
    } catch (error) {
      console.warn("Magyx Bundle: could not load bundle collections", error);
      // Keep the IDs so a failed lookup doesn't wipe selections on next save
      collections = collectionIds.map((id) => ({
        id,
        title: `Collection ${id.split("/").pop()}`,
        imageUrl: null,
      }));
    }
  }

  return {
    shopifyProduct,
    bundle: {
      id: bundle.id,
      title: bundle.title,
      description: bundle.description ?? "",
      type: bundle.type,
      status: bundle.status,
      pricingType: bundle.pricingType,
      pricingValue: bundle.pricingValue,
      shopifyProductId: bundle.shopifyProductId,
      items: bundle.items.map((i) => ({
        productId: i.productId,
        variantId: i.variantId,
        productTitle: i.productTitle,
        productImageUrl: i.productImageUrl,
        quantity: i.quantity,
        price: i.variantId ? (priceByVariant.get(i.variantId) ?? null) : null,
        missing:
          pricesLoaded && Boolean(i.variantId) && !priceByVariant.has(i.variantId!),
      })),
      collections,
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
  if (payload.type === "FIXED" && payload.items.length < 2)
    errors.push("Fixed bundles need at least two products.");
  if (payload.type !== "FIXED" && !hasPool)
    errors.push("Add products or select at least one collection for customers to pick from.");
  if (payload.pricingValue < 0) errors.push("Pricing value can't be negative.");
  if (payload.pricingType === "PERCENT_OFF" && payload.pricingValue > 100)
    errors.push("Discount can't be more than 100%.");
  if (payload.type === "MIX_MATCH" && (payload.rule?.discountTiers?.length ?? 0) === 0)
    errors.push("Add at least one discount tier.");
  if (payload.rule?.discountTiers?.some((t) => t.discount > 100))
    errors.push("Tier discounts can't be more than 100%.");
  if (payload.type === "SLOT_BUILDER" && (payload.rule?.minItems ?? 0) < 2)
    errors.push("Bundle builder needs at least two slots.");
  if (errors.length) return { errors };

  const input: BundleInput = {
    ...payload,
    items: payload.items.map((item, position) => ({ ...item, position })),
    rule: payload.type === "FIXED" ? null : payload.rule,
  };

  const bundle =
    params.id === "new"
      ? await createBundle(session.shop, input)
      : await updateBundle(session.shop, params.id!, input);

  // Publishing a fixed bundle creates/updates its parent product in Shopify
  if (bundle.type === "FIXED" && bundle.status === "ACTIVE") {
    const componentVariantIds = bundle.items
      .filter((i) => i.variantId)
      .map((i) => ({ variantId: i.variantId!, quantity: i.quantity }));
    try {
      await publishFixedBundleProduct(
        admin,
        {
          bundleId: bundle.id,
          title: bundle.title,
          description: bundle.description,
          pricingType: bundle.pricingType,
          pricingValue: bundle.pricingValue,
          componentVariantIds,
          displayItems: bundle.items.map((i) => ({
            title: i.productTitle,
            imageUrl: i.productImageUrl,
            quantity: i.quantity,
            variantId: i.variantId,
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

interface ItemState {
  productId: string;
  variantId: string | null;
  productTitle: string;
  productImageUrl: string | null;
  quantity: number;
  // Live variant price for display only (combined/compare-at math); not persisted
  price: number | null;
  // True when the referenced variant no longer exists in Shopify
  missing: boolean;
}

interface CollectionState {
  id: string;
  title: string;
  imageUrl: string | null;
}

interface TierState {
  quantity: string;
  discount: string;
}

const BUNDLE_TYPE_OPTIONS = [
  {
    value: "FIXED",
    label: "Fixed bundle",
    description: "A set combination sold as one product at a set price.",
  },
  {
    value: "SLOT_BUILDER",
    label: "Bundle builder",
    description:
      "A product with numbered slots — customers fill each slot from a pool of products.",
  },
  {
    value: "MIX_MATCH",
    label: "Mix & match",
    description:
      "Customers choose their own items from a list, with tiered discounts.",
  },
] as const;

function BundleTypeCard({
  label,
  description,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      style={{
        // Buttons vertically center their content by default; pin it to the
        // top so equal-height cards in the grid stay top-aligned
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        justifyContent: "flex-start",
        textAlign: "left",
        color: "var(--p-color-text)",
        padding: "var(--p-space-300)",
        borderRadius: "var(--p-border-radius-300)",
        border: selected
          ? "2px solid var(--p-color-border-emphasis)"
          : "1px solid var(--p-color-border)",
        // 1px compensation keeps unselected cards the same size as the
        // selected one despite the thinner border
        margin: selected ? 0 : 1,
        background: selected
          ? "var(--p-color-bg-surface-selected)"
          : "var(--p-color-bg-surface)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled && !selected ? 0.5 : 1,
        transition: "border-color 100ms ease, background 100ms ease",
      }}
    >
      <BlockStack gap="100">
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <RadioIndicator selected={selected} />
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {label}
          </Text>
        </InlineStack>
        <Text as="span" variant="bodySm" tone="subdued">
          {description}
        </Text>
      </BlockStack>
    </button>
  );
}

function RadioIndicator({ selected }: { selected: boolean }) {
  return (
    <span
      style={{
        width: 16,
        height: 16,
        flexShrink: 0,
        borderRadius: "50%",
        border: selected
          ? "5px solid var(--p-color-border-emphasis)"
          : "2px solid var(--p-color-border)",
        background: "var(--p-color-bg-surface)",
        transition: "border 100ms ease",
      }}
    />
  );
}

type LoaderBundle = SerializeFrom<typeof loader>["bundle"];

// Derives editor form state from the loaded bundle. Used for initial values,
// for resetting on discard, and as the baseline for dirty-state detection —
// keep field order stable, the dirty check compares JSON serializations.
function formStateOf(bundle: LoaderBundle) {
  return {
    title: bundle?.title ?? "",
    type: bundle?.type ?? "FIXED",
    status: bundle?.status ?? "DRAFT",
    pricingType:
      bundle?.pricingType ?? (bundle?.type === "MIX_MATCH" ? "PERCENT_OFF" : "FIXED_PRICE"),
    pricingValue: String(bundle?.pricingValue ?? ""),
    items:
      bundle?.items.map((i): ItemState => ({
        productId: i.productId,
        variantId: i.variantId ?? null,
        productTitle: i.productTitle,
        productImageUrl: i.productImageUrl ?? null,
        quantity: i.quantity,
        price: i.price ?? null,
        missing: i.missing ?? false,
      })) ?? [],
    collections: (bundle?.collections ?? []) as CollectionState[],
    poolSource: (bundle?.collections?.length ?? 0) > 0 ? "COLLECTIONS" : "PRODUCTS",
    slotCount: String((bundle?.type === "SLOT_BUILDER" && bundle?.rule?.minItems) || 3),
    minItems: String((bundle?.type === "MIX_MATCH" && bundle?.rule?.minItems) || 2),
    maxItems: bundle?.rule?.maxItems ? String(bundle.rule.maxItems) : "",
    tiers:
      bundle?.rule?.discountTiers.map(
        (t): TierState => ({
          quantity: String(t.quantity),
          discount: String(t.discount),
        }),
      ) ?? [{ quantity: "2", discount: "10" }],
  };
}

export default function BundleBuilder() {
  const { bundle, shopifyProduct } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const deleteFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const isNew = !bundle;

  const initialForm = useMemo(() => formStateOf(bundle), [bundle]);

  const [title, setTitle] = useState(initialForm.title);
  // No longer editable in the UI, but sent on save so existing values persist
  const description = bundle?.description ?? "";
  const [type, setType] = useState<string>(initialForm.type);
  const [status, setStatus] = useState<string>(initialForm.status);
  const [pricingType, setPricingType] = useState<string>(initialForm.pricingType);
  const [pricingValue, setPricingValue] = useState(initialForm.pricingValue);
  const [items, setItems] = useState<ItemState[]>(initialForm.items);
  const [collections, setCollections] = useState<CollectionState[]>(
    initialForm.collections,
  );
  const [poolSource, setPoolSource] = useState<string>(initialForm.poolSource);
  const [slotCount, setSlotCount] = useState(initialForm.slotCount);
  const [minItems, setMinItems] = useState(initialForm.minItems);
  const [maxItems, setMaxItems] = useState(initialForm.maxItems);
  const [tiers, setTiers] = useState<TierState[]>(initialForm.tiers);

  const isSaving = fetcher.state !== "idle";

  const isDirty = useMemo(
    () =>
      JSON.stringify({
        title, type, status, pricingType, pricingValue, items, collections,
        poolSource, slotCount, minItems, maxItems, tiers,
      }) !== JSON.stringify(initialForm),
    [
      initialForm, title, type, status, pricingType, pricingValue, items,
      collections, poolSource, slotCount, minItems, maxItems, tiers,
    ],
  );

  const discard = useCallback(() => {
    setTitle(initialForm.title);
    setType(initialForm.type);
    setStatus(initialForm.status);
    setPricingType(initialForm.pricingType);
    setPricingValue(initialForm.pricingValue);
    setItems(initialForm.items);
    setCollections(initialForm.collections);
    setPoolSource(initialForm.poolSource);
    setSlotCount(initialForm.slotCount);
    setMinItems(initialForm.minItems);
    setMaxItems(initialForm.maxItems);
    setTiers(initialForm.tiers);
  }, [initialForm]);
  const errors = fetcher.data && "errors" in fetcher.data ? fetcher.data.errors : null;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "saved" in fetcher.data) {
      shopify.toast.show("Bundle saved");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const openResourcePicker = useCallback(async () => {
    // Fixed bundles are variant-level: preselect the exact variants so the
    // picker shows them checked, and each selected variant becomes its own
    // line item. Pool types stay product-level.
    const selectionIds =
      type === "FIXED"
        ? Array.from(
            items.reduce((byProduct, item) => {
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
        : items.map((i) => ({ id: i.productId }));

    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "add",
      selectionIds,
    });
    if (!selection) return;

    const toPrice = (raw: unknown) => {
      const price = parseFloat(String(raw));
      return Number.isNaN(price) ? null : price;
    };

    if (type === "FIXED") {
      setItems((current) => {
        const byVariant = new Map(
          current.map((i) => [i.variantId ?? i.productId, i]),
        );
        return selection.flatMap((product: any) => {
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
              price: toPrice(variant?.price),
              missing: false,
            };
          });
        });
      });
      return;
    }

    setItems((current) => {
      const byProduct = new Map(current.map((i) => [i.productId, i]));
      return selection.map(
        (product: any) =>
          byProduct.get(product.id) ?? {
            productId: product.id,
            variantId: product.variants?.[0]?.id ?? null,
            productTitle: product.title,
            productImageUrl: product.images?.[0]?.originalSrc ?? null,
            quantity: 1,
            price: toPrice(product.variants?.[0]?.price),
            missing: false,
          },
      );
    });
  }, [shopify, items, type]);

  const openCollectionPicker = useCallback(async () => {
    const selection = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      action: "add",
      selectionIds: collections.map((c) => ({ id: c.id })),
    });
    if (!selection) return;
    setCollections(
      selection.map((collection: any) => ({
        id: collection.id,
        title: collection.title,
        imageUrl: collection.image?.originalSrc ?? null,
      })),
    );
  }, [shopify, collections]);

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

  const save = useCallback(() => {
    const usesCollections = type !== "FIXED" && poolSource === "COLLECTIONS";
    const collectionIds = usesCollections ? collections.map((c) => c.id) : [];
    const slots = parseInt(slotCount, 10) || 0;
    const payload = {
      title,
      description,
      type,
      status,
      pricingType,
      pricingValue: parseFloat(pricingValue) || 0,
      // price/missing are editor-only display state — the DB schema doesn't store them
      items: usesCollections
        ? []
        : items.map(({ price: _price, missing: _missing, ...item }) => item),
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
          : type === "SLOT_BUILDER"
            ? {
                // Customers must fill every slot, so min = max = slot count
                minItems: slots,
                maxItems: slots,
                discountTiers: [],
                collectionIds,
              }
            : null,
    };
    fetcher.submit(
      { payload: JSON.stringify(payload) },
      { method: "POST" },
    );
  }, [
    fetcher, title, description, type, status, pricingType, pricingValue,
    items, minItems, maxItems, tiers, poolSource, collections, slotCount,
  ]);

  // Mirrors the compare-at math in publishFixedBundleProduct so merchants see
  // exactly what will be set on the bundle product
  const combinedPrice = useMemo(
    () =>
      Math.round(
        items.reduce((sum, i) => sum + (i.price ?? 0) * i.quantity, 0) * 100,
      ) / 100,
    [items],
  );
  const hasMissingPrices = items.some((i) => i.price == null);
  const computedBundlePrice = useMemo(() => {
    const value = parseFloat(pricingValue) || 0;
    let price: number;
    if (pricingType === "FIXED_PRICE") price = value;
    else if (pricingType === "PERCENT_OFF") price = combinedPrice * (1 - value / 100);
    else price = combinedPrice - value;
    return Math.max(0, Math.round(price * 100) / 100);
  }, [pricingType, pricingValue, combinedPrice]);
  const pricingValueError =
    pricingType === "PERCENT_OFF" && (parseFloat(pricingValue) || 0) > 100
      ? "Discount can't be more than 100%."
      : (parseFloat(pricingValue) || 0) < 0
        ? "Value can't be negative."
        : undefined;
  const savings = Math.round((combinedPrice - computedBundlePrice) * 100) / 100;

  const previewSummary = useMemo(() => {
    if (type !== "MIX_MATCH") {
      if (pricingType === "FIXED_PRICE")
        return pricingValue ? `Bundle price: $${pricingValue}` : "Set a bundle price";
      if (pricingType === "PERCENT_OFF")
        return pricingValue ? `${pricingValue}% off combined price` : "Set a discount";
      return pricingValue ? `$${pricingValue} off combined price` : "Set a discount";
    }
    const valid = tiers.filter((t) => t.quantity && t.discount);
    if (valid.length === 0) return "Add discount tiers";
    return valid
      .map((t) => `Buy ${t.quantity}+ → ${t.discount}% off`)
      .join(" · ");
  }, [type, pricingType, pricingValue, tiers]);

  const showCollectionPool = type !== "FIXED" && poolSource === "COLLECTIONS";

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

        {items.some((i) => i.missing) && (
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

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Bundle type
                  </Text>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                      gap: "var(--p-space-300)",
                    }}
                  >
                    {BUNDLE_TYPE_OPTIONS.map((option) => (
                      <BundleTypeCard
                        key={option.value}
                        label={option.label}
                        description={option.description}
                        selected={type === option.value}
                        disabled={!isNew}
                        onSelect={() => {
                          setType(option.value);
                          setPricingType(
                            option.value === "FIXED" ? "FIXED_PRICE" : "PERCENT_OFF",
                          );
                        }}
                      />
                    ))}
                  </div>
                  {!isNew && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Bundle type can&apos;t be changed after the bundle is
                      created.
                    </Text>
                  )}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      {type === "FIXED" ? "Products in bundle" : "Product pool"}
                    </Text>
                    {showCollectionPool ? (
                      <Button icon={PlusIcon} onClick={openCollectionPicker}>
                        Add collections
                      </Button>
                    ) : (
                      <Button icon={PlusIcon} onClick={openResourcePicker}>
                        Add products
                      </Button>
                    )}
                  </InlineStack>
                  {type !== "FIXED" && (
                    <ChoiceList
                      title="Customers pick from"
                      choices={[
                        {
                          label: "Specific products",
                          value: "PRODUCTS",
                          helpText: "Hand-pick the products shown in the selection panel.",
                        },
                        {
                          label: "Collections",
                          value: "COLLECTIONS",
                          helpText:
                            "Show every product from the chosen collections — stays up to date automatically.",
                        },
                      ]}
                      selected={[poolSource]}
                      onChange={(value) => setPoolSource(value[0])}
                    />
                  )}
                  {showCollectionPool ? (
                    collections.length === 0 ? (
                      <Box padding="400">
                        <Text as="p" tone="subdued" alignment="center">
                          Select the collections customers can pick products from.
                        </Text>
                      </Box>
                    ) : (
                      <BlockStack gap="300">
                        {collections.map((collection, index) => (
                          <Box key={collection.id}>
                            {index > 0 && <Box paddingBlockEnd="300"><Divider /></Box>}
                            <InlineStack
                              gap="300"
                              blockAlign="center"
                              align="space-between"
                              wrap={false}
                            >
                              <InlineStack gap="300" blockAlign="center" wrap={false}>
                                <Thumbnail
                                  source={collection.imageUrl || ImageIcon}
                                  alt={collection.title}
                                  size="small"
                                />
                                <Text as="span" variant="bodyMd" fontWeight="medium">
                                  {collection.title}
                                </Text>
                              </InlineStack>
                              <Button
                                icon={DeleteIcon}
                                variant="tertiary"
                                tone="critical"
                                accessibilityLabel={`Remove ${collection.title}`}
                                onClick={() =>
                                  setCollections((current) =>
                                    current.filter((_, i) => i !== index),
                                  )
                                }
                              />
                            </InlineStack>
                          </Box>
                        ))}
                      </BlockStack>
                    )
                  ) : items.length === 0 ? (
                    <Box padding="400">
                      <Text as="p" tone="subdued" alignment="center">
                        {type === "FIXED"
                          ? "Add the products this bundle contains."
                          : "Add the products customers can pick from."}
                      </Text>
                    </Box>
                  ) : (
                    <BlockStack gap="300">
                      {items.map((item, index) => (
                        <Box key={item.variantId ?? item.productId}>
                          {index > 0 && <Box paddingBlockEnd="300"><Divider /></Box>}
                          <InlineStack
                            gap="300"
                            blockAlign="center"
                            align="space-between"
                            wrap={false}
                          >
                            <InlineStack gap="300" blockAlign="center" wrap={false}>
                              <Thumbnail
                                source={item.productImageUrl || ImageIcon}
                                alt={item.productTitle}
                                size="small"
                              />
                              <BlockStack gap="050">
                                <InlineStack gap="200" blockAlign="center">
                                  <Text as="span" variant="bodyMd" fontWeight="medium">
                                    {item.productTitle}
                                  </Text>
                                  {item.missing && (
                                    <Badge tone="critical">Deleted from store</Badge>
                                  )}
                                </InlineStack>
                                {item.price != null && (
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    ${item.price.toFixed(2)}
                                    {type === "FIXED" && item.quantity > 1
                                      ? ` × ${item.quantity} = $${(item.price * item.quantity).toFixed(2)}`
                                      : ""}
                                  </Text>
                                )}
                              </BlockStack>
                            </InlineStack>
                            <InlineStack gap="200" blockAlign="center" wrap={false}>
                              {type === "FIXED" && (
                                <div style={{ width: 90 }}>
                                  <TextField
                                    label="Qty"
                                    labelHidden
                                    type="number"
                                    min={1}
                                    value={String(item.quantity)}
                                    onChange={(value) =>
                                      setItems((current) =>
                                        current.map((c, i) =>
                                          i === index
                                            ? { ...c, quantity: Math.max(1, parseInt(value, 10) || 1) }
                                            : c,
                                        ),
                                      )
                                    }
                                    autoComplete="off"
                                    prefix="×"
                                  />
                                </div>
                              )}
                              <Button
                                icon={DeleteIcon}
                                variant="tertiary"
                                tone="critical"
                                accessibilityLabel={`Remove ${item.productTitle}`}
                                onClick={() =>
                                  setItems((current) =>
                                    current.filter((_, i) => i !== index),
                                  )
                                }
                              />
                            </InlineStack>
                          </InlineStack>
                        </Box>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {type === "SLOT_BUILDER" && (
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Slots
                    </Text>
                    <div style={{ maxWidth: 200 }}>
                      <TextField
                        label="Number of slots"
                        type="number"
                        min={2}
                        value={slotCount}
                        onChange={setSlotCount}
                        autoComplete="off"
                        helpText="Customers fill every slot to complete the bundle."
                      />
                    </div>
                  </BlockStack>
                </Card>
              )}

              {type !== "MIX_MATCH" ? (
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Pricing
                    </Text>
                    <ChoiceList
                      title="Pricing"
                      titleHidden
                      choices={[
                        { label: "Fixed bundle price", value: "FIXED_PRICE" },
                        { label: "Percentage off combined price", value: "PERCENT_OFF" },
                        { label: "Amount off combined price", value: "AMOUNT_OFF" },
                      ]}
                      selected={[pricingType]}
                      onChange={(value) => setPricingType(value[0])}
                    />
                    <div style={{ maxWidth: 200 }}>
                      <TextField
                        label={
                          pricingType === "FIXED_PRICE"
                            ? "Bundle price"
                            : pricingType === "PERCENT_OFF"
                              ? "Discount"
                              : "Amount off"
                        }
                        type="number"
                        min={0}
                        max={pricingType === "PERCENT_OFF" ? 100 : undefined}
                        value={pricingValue}
                        onChange={setPricingValue}
                        autoComplete="off"
                        prefix={pricingType === "PERCENT_OFF" ? undefined : "$"}
                        suffix={pricingType === "PERCENT_OFF" ? "%" : undefined}
                        error={pricingValueError}
                      />
                    </div>
                    {type === "FIXED" && items.length > 0 && (
                      <Box background="bg-surface-secondary" borderRadius="200" padding="300">
                        <BlockStack gap="200">
                          <InlineStack align="space-between" blockAlign="center">
                            <Text as="span" variant="bodyMd" tone="subdued">
                              Original price (compare-at)
                            </Text>
                            <Text
                              as="span"
                              variant="bodyMd"
                              tone="subdued"
                              textDecorationLine={
                                savings > 0 ? "line-through" : undefined
                              }
                            >
                              ${combinedPrice.toFixed(2)}
                            </Text>
                          </InlineStack>
                          <InlineStack align="space-between" blockAlign="center">
                            <Text as="span" variant="bodyMd">
                              Bundle price
                            </Text>
                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                              ${computedBundlePrice.toFixed(2)}
                            </Text>
                          </InlineStack>
                          <Divider />
                          <InlineStack align="space-between" blockAlign="center">
                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                              Customer saves
                            </Text>
                            <Text
                              as="span"
                              variant="bodyMd"
                              fontWeight="semibold"
                              tone={savings > 0 ? "success" : "subdued"}
                            >
                              ${Math.max(0, savings).toFixed(2)}
                              {savings > 0 && combinedPrice > 0
                                ? ` (${Math.round((savings / combinedPrice) * 100)}%)`
                                : ""}
                            </Text>
                          </InlineStack>
                          {savings > 0 ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                              The original ${combinedPrice.toFixed(2)} combined
                              price is set as the compare-at (strikethrough)
                              price on the bundle product.
                            </Text>
                          ) : (
                            <Text as="p" variant="bodySm" tone="caution">
                              The bundle price isn&apos;t below the combined
                              price of its products, so no compare-at price
                              will be shown to customers.
                            </Text>
                          )}
                          {hasMissingPrices && (
                            <Text as="p" variant="bodySm" tone="caution">
                              Some product prices couldn&apos;t be loaded, so
                              these totals may be incomplete.
                            </Text>
                          )}
                        </BlockStack>
                      </Box>
                    )}
                  </BlockStack>
                </Card>
              ) : (
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Rules &amp; discount tiers
                    </Text>
                    <InlineStack gap="400">
                      <div style={{ width: 140 }}>
                        <TextField
                          label="Minimum items"
                          type="number"
                          min={1}
                          value={minItems}
                          onChange={setMinItems}
                          autoComplete="off"
                        />
                      </div>
                      <div style={{ width: 140 }}>
                        <TextField
                          label="Maximum items"
                          type="number"
                          value={maxItems}
                          onChange={setMaxItems}
                          autoComplete="off"
                          placeholder="No limit"
                        />
                      </div>
                    </InlineStack>
                    <Divider />
                    <BlockStack gap="300">
                      <Text as="h3" variant="headingSm">
                        Discount tiers
                      </Text>
                      {tiers.map((tier, index) => (
                        <InlineStack key={index} gap="200" blockAlign="end" wrap={false}>
                          <div style={{ width: 140 }}>
                            <TextField
                              label="Buy at least"
                              type="number"
                              min={1}
                              value={tier.quantity}
                              onChange={(value) =>
                                setTiers((current) =>
                                  current.map((t, i) =>
                                    i === index ? { ...t, quantity: value } : t,
                                  ),
                                )
                              }
                              autoComplete="off"
                              suffix="items"
                            />
                          </div>
                          <div style={{ width: 140 }}>
                            <TextField
                              label="Get discount"
                              type="number"
                              min={0}
                              value={tier.discount}
                              onChange={(value) =>
                                setTiers((current) =>
                                  current.map((t, i) =>
                                    i === index ? { ...t, discount: value } : t,
                                  ),
                                )
                              }
                              autoComplete="off"
                              suffix="%"
                            />
                          </div>
                          <Button
                            icon={DeleteIcon}
                            variant="tertiary"
                            accessibilityLabel="Remove tier"
                            onClick={() =>
                              setTiers((current) =>
                                current.filter((_, i) => i !== index),
                              )
                            }
                            disabled={tiers.length === 1}
                          />
                        </InlineStack>
                      ))}
                      <div>
                        <Button
                          icon={PlusIcon}
                          variant="plain"
                          onClick={() =>
                            setTiers((current) => [
                              ...current,
                              { quantity: "", discount: "" },
                            ])
                          }
                        >
                          Add tier
                        </Button>
                      </div>
                    </BlockStack>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Preview
                  </Text>
                  <Badge
                    tone={
                      type === "FIXED"
                        ? "info"
                        : type === "SLOT_BUILDER"
                          ? "attention"
                          : "magic"
                    }
                  >
                    {type === "FIXED"
                      ? "Fixed"
                      : type === "SLOT_BUILDER"
                        ? "Bundle builder"
                        : "Mix & match"}
                  </Badge>
                </InlineStack>
                <Divider />
                <Text as="p" variant="headingSm">
                  {title || "Untitled bundle"}
                </Text>
                {description && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {description}
                  </Text>
                )}
                <BlockStack gap="200">
                  {showCollectionPool ? (
                    <>
                      {collections.map((collection) => (
                        <InlineStack
                          key={collection.id}
                          gap="200"
                          blockAlign="center"
                          wrap={false}
                        >
                          <Thumbnail
                            source={collection.imageUrl || ImageIcon}
                            alt={collection.title}
                            size="extraSmall"
                          />
                          <Text as="span" variant="bodySm" truncate>
                            {collection.title}
                          </Text>
                        </InlineStack>
                      ))}
                      {collections.length === 0 && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          No collections yet
                        </Text>
                      )}
                    </>
                  ) : (
                    <>
                      {items.slice(0, 5).map((item) => (
                        <InlineStack key={item.productId} gap="200" blockAlign="center" wrap={false}>
                          <Thumbnail
                            source={item.productImageUrl || ImageIcon}
                            alt={item.productTitle}
                            size="extraSmall"
                          />
                          <Text as="span" variant="bodySm" truncate>
                            {type === "FIXED" ? `${item.quantity} × ` : ""}
                            {item.productTitle}
                          </Text>
                        </InlineStack>
                      ))}
                      {items.length > 5 && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          +{items.length - 5} more
                        </Text>
                      )}
                      {items.length === 0 && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          No products yet
                        </Text>
                      )}
                    </>
                  )}
                </BlockStack>
                <Divider />
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  {previewSummary}
                </Text>
                {type === "MIX_MATCH" && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Customers pick {minItems || "?"}
                    {maxItems ? `–${maxItems}` : "+"} items from{" "}
                    {showCollectionPool
                      ? `${collections.length} collection${collections.length === 1 ? "" : "s"}`
                      : `${items.length} eligible product${items.length === 1 ? "" : "s"}`}
                    .
                  </Text>
                )}
                {type === "SLOT_BUILDER" && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Customers fill {slotCount || "?"} slots from{" "}
                    {showCollectionPool
                      ? `${collections.length} collection${collections.length === 1 ? "" : "s"}`
                      : `${items.length} product${items.length === 1 ? "" : "s"} in the pool`}
                    .
                  </Text>
                )}
              </BlockStack>
            </Card>
            <Box paddingBlockStart="400">
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Publishing
                  </Text>
                  <Select
                    label="Status"
                    options={[
                      { label: "Draft", value: "DRAFT" },
                      { label: "Active", value: "ACTIVE" },
                    ]}
                    value={status}
                    onChange={setStatus}
                  />
                  <Text as="p" variant="bodySm" tone="subdued">
                    {type === "FIXED"
                      ? "When set to Active, Magyx Bundle creates a bundle product in your store. It's expanded into its components at checkout, so inventory stays accurate."
                      : type === "SLOT_BUILDER"
                        ? "When set to Active, this bundle gets its own product page where customers fill each slot from your product pool. Storefront widget support is coming next."
                        : "When set to Active, the mix & match builder becomes available as an app block in your theme editor, and discounts apply automatically at checkout."}
                  </Text>
                  {!isNew && type === "FIXED" && bundle!.shopifyProductId && (
                    shopifyProduct ? (
                      <Box
                        borderColor="border"
                        borderWidth="025"
                        borderRadius="200"
                        padding="300"
                      >
                        <InlineStack
                          gap="300"
                          blockAlign="center"
                          align="space-between"
                          wrap={false}
                        >
                          <InlineStack gap="300" blockAlign="center" wrap={false}>
                            <Thumbnail
                              source={shopifyProduct.imageUrl || ImageIcon}
                              alt={shopifyProduct.title}
                              size="small"
                            />
                            <BlockStack gap="100">
                              <Text as="span" variant="bodyMd" fontWeight="medium">
                                {shopifyProduct.title}
                              </Text>
                              <InlineStack gap="200" blockAlign="center">
                                <Badge
                                  size="small"
                                  tone={
                                    shopifyProduct.status === "ACTIVE"
                                      ? "success"
                                      : shopifyProduct.status === "DRAFT"
                                        ? "info"
                                        : undefined
                                  }
                                >
                                  {shopifyProduct.status.charAt(0) +
                                    shopifyProduct.status.slice(1).toLowerCase()}
                                </Badge>
                                {shopifyProduct.price && (
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    ${shopifyProduct.price}
                                  </Text>
                                )}
                              </InlineStack>
                            </BlockStack>
                          </InlineStack>
                          <Button
                            icon={EditIcon}
                            variant="tertiary"
                            accessibilityLabel="Edit bundle product"
                            onClick={editBundleProduct}
                          />
                        </InlineStack>
                      </Box>
                    ) : (
                      <div>
                        <Button variant="plain" onClick={editBundleProduct}>
                          View bundle product in admin
                        </Button>
                      </div>
                    )
                  )}
                  {!isNew && type === "MIX_MATCH" && (
                    <TextField
                      label="Bundle ID"
                      value={bundle!.id}
                      readOnly
                      autoComplete="off"
                      helpText="Paste this into the Mix & Match Bundle block in your theme editor."
                      connectedRight={
                        <Button
                          onClick={() => {
                            navigator.clipboard.writeText(bundle!.id);
                            shopify.toast.show("Bundle ID copied");
                          }}
                        >
                          Copy
                        </Button>
                      }
                    />
                  )}
                </BlockStack>
              </Card>
            </Box>
          </Layout.Section>
        </Layout>

        {/* Breathing room below the last card; credit text can live here later */}
        <Box paddingBlockEnd="1000" />
      </BlockStack>
    </Page>
  );
}
