import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { getBundles, setBundleProduct, setPackageVariant } from "./bundle.server";
import type {
  PackageTranslations,
  SlotBuilderTranslations,
} from "../utils/slot-builder-text";

const CONFIG_NAMESPACE = "$app:magyx-bundle";
const CONFIG_KEY = "config";

// Cap on how many pool products get baked into the Bundle Builder's display
// metafield as a storefront snapshot. Keeps page weight bounded regardless of
// pool size (a COLLECTIONS-sourced pool can run to thousands of products) —
// the live app-proxy fetch remains the source of truth for the full pool,
// this is only a same-page fallback so the widget still renders/works if
// that fetch fails.
const POOL_SNAPSHOT_LIMIT = 60;

/**
 * Publishes all ACTIVE bundles for the shop into an app-owned shop metafield.
 * The Cart Transform function reads this metafield to price mix & match
 * bundles and validate fixed bundles at checkout — server-side truth, so the
 * storefront can never tamper with discounts.
 */
export async function syncBundleConfigMetafield(admin: AdminApiContext, shop: string) {
  const bundles = await getBundles(shop);
  const active = bundles.filter((b) => b.status === "ACTIVE");

  const bundlesConfig = await Promise.all(
    active.map(async (b) => {
      // QUANTITY_BREAKS: the Cart Transform function has no way to check
      // collection membership dynamically at checkout (Shopify Functions
      // require collection ids baked into the deployed query), so ALL/
      // COLLECTIONS scope is resolved into a concrete product id list here,
      // at sync time — PRODUCTS scope already is one. This means a product
      // added to a scoped collection won't get the discount until the next
      // sync (any bundle save, or an activate/deactivate from the bundle list).
      let quantityBreakProductIds: string[] | undefined;
      if (b.type === "QUANTITY_BREAKS" && b.quantityBreakScope === "PRODUCTS") {
        quantityBreakProductIds = b.items.map((i) => i.productId);
      } else if (b.type === "QUANTITY_BREAKS" && b.quantityBreakScope === "COLLECTIONS") {
        const collectionIds: string[] = b.rule ? JSON.parse(b.rule.collectionIds) : [];
        quantityBreakProductIds = await resolveCollectionProductIds(admin, collectionIds);
      }

      // SLOT_BUILDER: each package has its own pool + slot count, so the
      // Cart Transform function needs to verify every product a customer
      // claims to have picked is actually in *that package's* pool before
      // trusting the selection — otherwise a forged cart line property could
      // swap in an arbitrary out-of-pool product for the bundle's flat
      // price. Same resolution as QUANTITY_BREAKS above: PRODUCTS scope is
      // already a concrete list, COLLECTIONS is flattened into one here (a
      // product added to a scoped collection won't be eligible until the
      // next sync).
      let slotBuilderPackages:
        | {
            shopifyVariantId: string | null;
            freeShipping: boolean;
            slotCount: number;
            slotPoolProductIds: string[];
            gifts: { variantId: string; quantity: number }[];
          }[]
        | undefined;
      if (b.type === "SLOT_BUILDER") {
        // Gifts are progressive across packages: a package ships its own
        // gifts plus every earlier package's (package order = position, i.e.
        // the tab order in the editor). Merged by variantId with the highest
        // quantity winning — a later tier can upgrade an earlier tier's gift
        // quantity without double-shipping the same freebie. Baked here at
        // sync time so the Cart Transform function needs no notion of
        // package order.
        const cumulativeGiftsByPackage: { variantId: string; quantity: number }[][] = [];
        const giftQtyByVariant = new Map<string, number>();
        // Free shipping is a gift like any other, so it inherits the same way:
        // once a package turns it on, every bigger package keeps it. The
        // storefront widget already renders it that way (its virtual shipping
        // card unlocks at the first package that enables it and stays
        // unlocked), so anything less here would promise the perk and then
        // charge for it.
        const cumulativeFreeShippingByPackage: boolean[] = [];
        let freeShippingSoFar = false;
        for (const p of b.packages) {
          for (const i of p.items) {
            if (!i.isGift || !i.variantId) continue;
            giftQtyByVariant.set(
              i.variantId,
              Math.max(giftQtyByVariant.get(i.variantId) ?? 0, i.quantity),
            );
          }
          cumulativeGiftsByPackage.push(
            Array.from(giftQtyByVariant, ([variantId, quantity]) => ({ variantId, quantity })),
          );
          freeShippingSoFar = freeShippingSoFar || p.freeShipping;
          cumulativeFreeShippingByPackage.push(freeShippingSoFar);
        }
        slotBuilderPackages = await Promise.all(
          b.packages.map(async (p, index) => {
            const poolProductIds = p.items.filter((i) => !i.isGift).map((i) => i.productId);
            const slotPoolProductIds =
              poolProductIds.length > 0
                ? poolProductIds
                : await resolveCollectionProductIds(admin, JSON.parse(p.collectionIds));
            return {
              shopifyVariantId: p.shopifyVariantId,
              freeShipping: cumulativeFreeShippingByPackage[index],
              slotCount: p.slotCount,
              slotPoolProductIds,
              gifts: cumulativeGiftsByPackage[index],
            };
          }),
        );
      }

      return {
        id: b.id,
        type: b.type,
        pricingType: b.pricingType,
        pricingValue: b.pricingValue,
        shopifyProductId: b.shopifyProductId,
        items: b.items.map((i) => ({
          productId: i.productId,
          variantId: i.variantId,
          quantity: i.quantity,
        })),
        quantityBreakScope: b.type === "QUANTITY_BREAKS" ? b.quantityBreakScope : undefined,
        // ALL scope needs no list — every product matches
        quantityBreakProductIds,
        // SLOT_BUILDER packages (bottle size / pack size), each keyed by its
        // own Shopify variant id so the Cart Transform function can find the
        // right pool/slot count/free-shipping flag/gift list for whichever
        // package the customer bought. FIXED bundles don't need this — their
        // per-variant checkout truth already lives in that variant's own
        // `$app:magyx-bundle/components` metafield.
        packages: slotBuilderPackages,
        tiers:
          b.type === "QUANTITY_BREAKS"
            ? b.tiers.map((t) => ({
                quantity: t.quantity,
                pricingType: t.pricingType,
                pricingValue: t.pricingValue,
                // Free gifts bundled with this pack size — the Cart Transform
                // function expands the qualifying line to add these at $0.
                giftVariantIds: t.items
                  .filter((i) => i.variantId)
                  .map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
              }))
            : undefined,
        rule: b.rule
          ? {
              minItems: b.rule.minItems,
              maxItems: b.rule.maxItems,
              discountTiers: JSON.parse(b.rule.discountTiers),
              collectionIds: JSON.parse(b.rule.collectionIds),
            }
          : null,
      };
    }),
  );

  const config = { bundles: bundlesConfig };

  const shopIdResponse = await admin.graphql(`#graphql
    query shopId { shop { id } }`);
  const shopId = (await shopIdResponse.json()).data.shop.id;

  const response = await admin.graphql(
    `#graphql
    mutation setBundleConfig($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: CONFIG_NAMESPACE,
            key: CONFIG_KEY,
            type: "json",
            value: JSON.stringify(config),
          },
        ],
      },
    },
  );
  const json = await response.json();
  const errors = json.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    throw new Error(`Failed to sync bundle config: ${JSON.stringify(errors)}`);
  }

  if (active.length > 0) {
    await ensureCartTransformActivated(admin);
  }
  // FIXED bundles carry freeShipping per package now; MIX_MATCH/SLOT_BUILDER
  // still use the bundle-level flag.
  if (active.some((b) => b.freeShipping || b.packages.some((p) => p.freeShipping))) {
    await ensureFreeShippingDiscountActivated(admin);
  }
}

/**
 * Flattens every product in the given collections into a single deduped list
 * of product GIDs. Used to resolve a QUANTITY_BREAKS bundle's COLLECTIONS
 * scope into the concrete id list the Cart Transform function needs (it has
 * no way to check collection membership dynamically at checkout).
 *
 * `limit`, when passed, stops paginating as soon as enough ids are collected
 * instead of walking the whole collection — used when building the storefront
 * pool snapshot below, where only a bounded preview is needed. Callers that
 * need the full membership (Cart Transform validation) omit it.
 */
export async function resolveCollectionProductIds(
  admin: AdminApiContext,
  collectionIds: string[],
  limit?: number,
): Promise<string[]> {
  if (collectionIds.length === 0) return [];
  const ids = new Set<string>();
  for (const collectionId of collectionIds) {
    if (limit != null && ids.size >= limit) break;
    let hasNextPage = true;
    let cursor: string | null = null;
    while (hasNextPage) {
      const response = await admin.graphql(
        `#graphql
        query quantityBreakCollectionProducts($id: ID!, $cursor: String) {
          collection(id: $id) {
            products(first: 250, after: $cursor) {
              edges { node { id } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { variables: { id: collectionId, cursor } },
      );
      const json: {
        data?: {
          collection?: {
            products?: {
              edges: { node: { id: string } }[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        };
      } = await response.json();
      const products = json.data?.collection?.products;
      for (const edge of products?.edges ?? []) ids.add(edge.node.id);
      hasNextPage = products?.pageInfo?.hasNextPage ?? false;
      cursor = products?.pageInfo?.endCursor ?? null;
      if (limit != null && ids.size >= limit) break;
    }
  }
  return Array.from(ids);
}

/**
 * A deployed Cart Transform function must be activated once per shop.
 * Idempotent: does nothing if already activated. Fails softly (logs) when the
 * function isn't deployed yet, so local saves keep working before first deploy.
 */
export async function ensureCartTransformActivated(admin: AdminApiContext) {
  try {
    const existingResponse = await admin.graphql(`#graphql
      query cartTransforms { cartTransforms(first: 5) { edges { node { id } } } }`);
    const existing = (await existingResponse.json()).data?.cartTransforms?.edges ?? [];
    if (existing.length > 0) return;

    const functionsResponse = await admin.graphql(`#graphql
      query bundleFunctions {
        shopifyFunctions(first: 25, apiType: "cart_transform") {
          edges { node { id title } }
        }
      }`);
    const functions =
      (await functionsResponse.json()).data?.shopifyFunctions?.edges ?? [];
    const fn = functions[0]?.node;
    if (!fn) {
      console.warn(
        "Magyx Bundle: cart transform function not found — deploy the app to install it.",
      );
      return;
    }

    const createResponse = await admin.graphql(
      `#graphql
      mutation activateCartTransform($functionId: String!) {
        cartTransformCreate(functionId: $functionId, blockOnFailure: false) {
          cartTransform { id }
          userErrors { field message }
        }
      }`,
      { variables: { functionId: fn.id } },
    );
    const errors =
      (await createResponse.json()).data?.cartTransformCreate?.userErrors ?? [];
    if (errors.length) {
      console.warn("Magyx Bundle: cartTransformCreate errors", errors);
    }
  } catch (error) {
    console.warn("Magyx Bundle: could not activate cart transform", error);
  }
}

/**
 * The free-shipping Discount Function must be activated once per shop as an
 * automatic app discount. Idempotent: does nothing if already activated.
 * Fails softly (logs) when the function isn't deployed yet.
 */
async function ensureFreeShippingDiscountActivated(admin: AdminApiContext) {
  try {
    const existingResponse = await admin.graphql(`#graphql
      query freeShippingDiscounts {
        discountNodes(first: 5, query: "title:'Magyx Bundle — Free Shipping Gift'") {
          edges { node { id } }
        }
      }`);
    const existing =
      (await existingResponse.json()).data?.discountNodes?.edges ?? [];
    if (existing.length > 0) return;

    const functionsResponse = await admin.graphql(`#graphql
      query bundleFreeShippingFunctions {
        shopifyFunctions(first: 25) {
          edges { node { id title apiType } }
        }
      }`);
    const functions =
      (await functionsResponse.json()).data?.shopifyFunctions?.edges ?? [];
    const fn = functions.find(
      (edge: { node: { title: string } }) => edge.node.title === "Magyx Free Shipping",
    )?.node;
    if (!fn) {
      console.warn(
        "Magyx Bundle: free shipping function not found — deploy the app to install it.",
      );
      return;
    }

    const createResponse = await admin.graphql(
      `#graphql
      mutation activateFreeShippingDiscount($discount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $discount) {
          automaticAppDiscount { discountId }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          discount: {
            title: "Magyx Bundle — Free Shipping Gift",
            functionId: fn.id,
            discountClasses: ["SHIPPING"],
            startsAt: new Date().toISOString(),
            combinesWith: {
              orderDiscounts: true,
              productDiscounts: true,
              // A shipping-class discount can't declare itself combinable with
              // other shipping discounts — Shopify rejects the create with
              // "is not supported with these combines_with settings" otherwise.
              shippingDiscounts: false,
            },
          },
        },
      },
    );
    const errors =
      (await createResponse.json()).data?.discountAutomaticAppCreate?.userErrors ?? [];
    if (errors.length) {
      console.warn("Magyx Bundle: discountAutomaticAppCreate errors", errors);
    }
  } catch (error) {
    console.warn("Magyx Bundle: could not activate free shipping discount", error);
  }
}

/**
 * Products created via the API aren't visible on any sales channel until
 * they're published. Publishes to the Online Store channel; soft-fails so a
 * missing write_publications scope doesn't block saving the bundle itself.
 */
async function publishProductToOnlineStore(admin: AdminApiContext, productId: string) {
  try {
    const pubResponse = await admin.graphql(`#graphql
      query publications { publications(first: 10) { edges { node { id name } } } }`);
    const publications =
      (await pubResponse.json()).data?.publications?.edges ?? [];
    const onlineStore = publications.find(
      (edge: { node: { id: string; name: string } }) =>
        edge.node.name === "Online Store",
    );
    if (!onlineStore) return;

    const publishResponse = await admin.graphql(
      `#graphql
      mutation publishBundleProduct($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          id: productId,
          input: [{ publicationId: onlineStore.node.id }],
        },
      },
    );
    const errors =
      (await publishResponse.json()).data?.publishablePublish?.userErrors ?? [];
    if (errors.length) {
      console.warn("Magyx Bundle: publishablePublish errors", errors);
    }
  } catch (error) {
    console.warn("Magyx Bundle: could not publish product to Online Store", error);
  }
}

// One purchase option under the bundle (e.g. "2 Pack"). A bundle with exactly
// one package publishes to a single-variant product identically to the
// original single-config FIXED bundle; more than one package publishes N
// variants (one per package) on the same product, each carrying its own
// checkout-truth metafield.
interface FixedBundlePackageInput {
  packageId: string;
  // The Shopify variant this package was last published to, if any — used to
  // match packages to variants across saves (renames, additions, removals)
  // instead of relying on label text, which merchants can freely edit.
  existingVariantId?: string | null;
  label: string;
  badgeText?: string | null;
  badgeTone?: string | null;
  pricingType: string;
  pricingValue: number;
  freeShipping: boolean;
  componentVariantIds: { variantId: string; quantity: number; isGift?: boolean }[];
  // Denormalized item info for the storefront widget's "what's inside" cards
  displayItems: {
    title: string;
    imageUrl: string | null;
    quantity: number;
    productId: string;
    variantId: string | null;
    isGift?: boolean;
  }[];
}

interface FixedBundlePublishInput {
  bundleId: string;
  title: string;
  description?: string | null;
  packages: FixedBundlePackageInput[];
  // Appearance of the storefront "what's inside" widget — set entirely from
  // the app admin, the theme block has no editable settings of its own.
  // Shared across all packages of a bundle.
  widgetSettings: {
    style: string;
    heading: string;
    accentColor: string;
    showPrices: boolean;
    itemSubtextTemplate: string;
    showSubtextOnGifts: boolean;
  };
}

const PACK_OPTION_NAME = "Pack";

// {{metafield:ns.key}} reads a plain metafield's value. {{metafield:ns.key.value.field}}
// mirrors Liquid's own `metafield.value.field` convention for a metaobject
// reference: ns.key is the reference metafield, `field` is the metaobject's
// field key.
const SUBTEXT_PLACEHOLDER_RE =
  /\{\{\s*(?<basic>sku|vendor|type|barcode|weight)\s*\}\}|\{\{\s*metafield:(?<moNamespace>[a-zA-Z0-9_]+)\.(?<moKey>[a-zA-Z0-9_]+)\.value\.(?<moField>[a-zA-Z0-9_]+)\s*\}\}|\{\{\s*metafield:(?<namespace>[a-zA-Z0-9_]+)\.(?<key>[a-zA-Z0-9_]+)\s*\}\}/g;

interface MetafieldRef {
  namespace: string;
  key: string;
  // Set when the placeholder digs into a metaobject reference's field
  field?: string;
}

function metafieldRefMapKey(ref: MetafieldRef): string {
  return ref.field ? `${ref.namespace}.${ref.key}.value.${ref.field}` : `${ref.namespace}.${ref.key}`;
}

function extractMetafieldRefs(template: string): MetafieldRef[] {
  const refs = new Map<string, MetafieldRef>();
  const re = new RegExp(SUBTEXT_PLACEHOLDER_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(template))) {
    const groups = match.groups ?? {};
    const ref: MetafieldRef | null =
      groups.moNamespace && groups.moKey && groups.moField
        ? { namespace: groups.moNamespace, key: groups.moKey, field: groups.moField }
        : groups.namespace && groups.key
          ? { namespace: groups.namespace, key: groups.key }
          : null;
    if (ref) refs.set(metafieldRefMapKey(ref), ref);
  }
  return Array.from(refs.values());
}

interface ItemDetails {
  sku: string | null;
  vendor: string | null;
  type: string | null;
  barcode: string | null;
  weight: string | null;
  metafields: Record<string, string | null>;
}

function resolveItemSubtext(template: string, details: ItemDetails): string {
  return template
    .replace(SUBTEXT_PLACEHOLDER_RE, (...args) => {
      const groups = args[args.length - 1] as Record<string, string | undefined>;
      if (groups.basic) {
        return details[groups.basic as keyof Omit<ItemDetails, "metafields">] ?? "";
      }
      if (groups.moNamespace && groups.moKey && groups.moField) {
        return (
          details.metafields[
            metafieldRefMapKey({ namespace: groups.moNamespace, key: groups.moKey, field: groups.moField })
          ] ?? ""
        );
      }
      if (groups.namespace && groups.key) {
        return details.metafields[metafieldRefMapKey({ namespace: groups.namespace, key: groups.key })] ?? "";
      }
      return "";
    })
    .trim();
}

/**
 * Resolves {{sku}}/{{vendor}}/{{type}}/{{barcode}}/{{weight}}/{{metafield:ns.key}}
 * /{{metafield:ns.key.value.field}} placeholders in the merchant's item
 * subtext template against live product data — one extra query, only made
 * when a template is actually set.
 */
export async function fetchItemSubtexts(
  admin: AdminApiContext,
  items: { productId: string; variantId: string | null }[],
  template: string,
): Promise<Map<string, string>> {
  const metafieldRefs = extractMetafieldRefs(template);
  const plainRefs = metafieldRefs.filter((ref) => !ref.field);
  const metaobjectRefs = metafieldRefs.filter((ref) => ref.field);
  const productIds = Array.from(new Set(items.map((i) => i.productId)));
  const variantIds = items
    .map((i) => i.variantId)
    .filter((id): id is string => Boolean(id));

  const plainFragment = plainRefs
    .map((ref, i) => `mf${i}: metafield(namespace: "${ref.namespace}", key: "${ref.key}") { value }`)
    .join("\n");

  const response = await admin.graphql(
    `#graphql
    query bundleItemSubtextDetails($productIds: [ID!]!, $variantIds: [ID!]!) {
      products: nodes(ids: $productIds) {
        ... on Product {
          id
          vendor
          productType
          ${plainFragment}
        }
      }
      variants: nodes(ids: $variantIds) {
        ... on ProductVariant {
          id
          sku
          barcode
          inventoryItem {
            measurement {
              weight { value unit }
            }
          }
        }
      }
    }`,
    { variables: { productIds, variantIds } },
  );
  const json = await response.json();
  if ((json as { errors?: unknown }).errors) {
    console.warn(
      "Magyx Bundle: item subtext base query errors",
      JSON.stringify((json as { errors?: unknown }).errors),
    );
  }
  const productById = new Map<string, Record<string, unknown>>(
    ((json.data?.products ?? []) as (Record<string, unknown> | null)[])
      .filter((p): p is Record<string, unknown> => Boolean(p))
      .map((p) => [p.id as string, p]),
  );
  const variantById = new Map<string, Record<string, unknown>>(
    ((json.data?.variants ?? []) as (Record<string, unknown> | null)[])
      .filter((v): v is Record<string, unknown> => Boolean(v))
      .map((v) => [v.id as string, v]),
  );

  // Kept in its own request: metaobject reference lookups are more likely to
  // hit a schema/argument edge case (e.g. a field key that doesn't exist on
  // that metaobject definition), and a failure here shouldn't blank out the
  // sku/vendor/plain-metafield placeholders resolved above.
  const metaobjectById = new Map<string, Record<string, unknown>>();
  if (metaobjectRefs.length > 0) {
    try {
      const metaobjectFragment = metaobjectRefs
        .map(
          (ref, i) => `mf${i}: metafield(namespace: "${ref.namespace}", key: "${ref.key}") {
             reference { ... on Metaobject { field(key: "${ref.field}") { value } } }
             references(first: 1) {
               nodes { ... on Metaobject { field(key: "${ref.field}") { value } } }
             }
           }`,
        )
        .join("\n");
      const moResponse = await admin.graphql(
        `#graphql
        query bundleItemSubtextMetaobjectDetails($productIds: [ID!]!) {
          products: nodes(ids: $productIds) {
            ... on Product {
              id
              ${metaobjectFragment}
            }
          }
        }`,
        { variables: { productIds } },
      );
      const moJson = await moResponse.json();
      if ((moJson as { errors?: unknown }).errors) {
        console.warn(
          "Magyx Bundle: item subtext metaobject query errors — check that each {{metafield:ns.key.value.field}} field key exists on the referenced metaobject definition",
          JSON.stringify((moJson as { errors?: unknown }).errors),
        );
      }
      ((moJson.data?.products ?? []) as (Record<string, unknown> | null)[])
        .filter((p): p is Record<string, unknown> => Boolean(p))
        .forEach((p) => metaobjectById.set(p.id as string, p));
    } catch (error) {
      console.warn("Magyx Bundle: could not resolve metaobject reference fields", error);
    }
  }

  const subtextByKey = new Map<string, string>();
  for (const item of items) {
    const product = productById.get(item.productId);
    const metaobjectProduct = metaobjectById.get(item.productId);
    const variant = item.variantId ? variantById.get(item.variantId) : undefined;
    const metafields: Record<string, string | null> = {};
    plainRefs.forEach((ref, i) => {
      const mf = product?.[`mf${i}`] as { value?: string } | null | undefined;
      metafields[metafieldRefMapKey(ref)] = mf?.value ?? null;
    });
    metaobjectRefs.forEach((ref, i) => {
      const mf = metaobjectProduct?.[`mf${i}`] as
        | {
            reference?: { field?: { value?: string } | null } | null;
            references?: { nodes?: { field?: { value?: string } | null }[] } | null;
          }
        | null
        | undefined;
      metafields[metafieldRefMapKey(ref)] =
        mf?.reference?.field?.value ?? mf?.references?.nodes?.[0]?.field?.value ?? null;
    });
    const weight = (
      variant?.inventoryItem as
        | { measurement?: { weight?: { value: number; unit: string } | null } }
        | undefined
    )?.measurement?.weight;
    const details: ItemDetails = {
      sku: (variant?.sku as string | null) ?? null,
      vendor: (product?.vendor as string | null) ?? null,
      type: (product?.productType as string | null) ?? null,
      barcode: (variant?.barcode as string | null) ?? null,
      weight: weight ? `${weight.value} ${weight.unit.toLowerCase()}` : null,
      metafields,
    };
    subtextByKey.set(item.variantId ?? item.productId, resolveItemSubtext(template, details));
  }
  return subtextByKey;
}

export interface ProductPoolItem {
  productId: string;
  variantId: string;
  title: string;
  // Raw variant title (e.g. "50ml"), separate from the combined `title`
  // above (e.g. "Product — 50ml") — lets callers filter by variant text
  // without accidentally matching text in the product's own name.
  variantTitle: string;
  image: string | null;
  price: number;
  available: boolean;
  subtext: string | null;
  // The parent product's tags — what the storefront pool modal's tag filter
  // chips (BundlePackage.tagFilters) match against.
  tags: string[];
}

// Same "{{sku}}/{{vendor}}/{{metafield:...}}" template the admin sets once
// per bundle for the Bundle Contents widget — reused here so pool items show
// the same subtext line everywhere. Soft-fails: a broken template shouldn't
// blank out the pool. Shared by fetchProductPoolItems and
// fetchVariantPoolItems below.
async function attachPoolItemSubtext(
  admin: AdminApiContext,
  items: ProductPoolItem[],
  subtextTemplate?: string | null,
): Promise<void> {
  const trimmedTemplate = subtextTemplate?.trim();
  if (!trimmedTemplate) return;
  try {
    const subtextByKey = await fetchItemSubtexts(
      admin,
      items.map((item) => ({ productId: item.productId, variantId: item.variantId })),
      trimmedTemplate,
    );
    for (const item of items) {
      item.subtext = subtextByKey.get(item.variantId) || null;
    }
  } catch (error) {
    console.warn("Magyx Bundle: could not resolve pool item subtext", error);
  }
}

/**
 * Resolves display data (title/image/price/availability, optionally a
 * subtext line) for every variant of a bounded list of products — a
 * 3-variant product yields 3 pickable pool items, each addressable by its
 * own variantId. Used for COLLECTIONS-sourced pools, where there's no
 * merchant-picked variant to respect, so every variant of every product in
 * the collection is pickable. Safe to expand past the first variant: the
 * Cart Transform function's pool check
 * (extensions/bundle-pricing/src/run.js) already only validates the picked
 * productId is in-pool, not a specific variant.
 *
 * For PRODUCTS-sourced ("Specific products") pools, use
 * fetchVariantPoolItems instead — the merchant already chose a specific
 * variant there, and expanding to every sibling variant would silently
 * override that choice.
 *
 * `variantTitleFilter`, when set, keeps only variants whose own title
 * contains it (case-insensitive) — e.g. "50" narrows a whole collection's
 * pool down to just its "50ml" variants, without hand-picking products.
 */
export async function fetchProductPoolItems(
  admin: AdminApiContext,
  productIds: string[],
  subtextTemplate?: string | null,
  variantTitleFilter?: string | null,
): Promise<ProductPoolItem[]> {
  if (productIds.length === 0) return [];
  const trimmedFilter = variantTitleFilter?.trim().toLowerCase();

  const response = await admin.graphql(
    `#graphql
    query productPoolItems($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          tags
          featuredImage { url(transform: { maxWidth: 360, maxHeight: 360 }) }
          variants(first: 100) {
            edges {
              node {
                id
                title
                price
                availableForSale
                image { url(transform: { maxWidth: 360, maxHeight: 360 }) }
              }
            }
          }
        }
      }
    }`,
    { variables: { ids: productIds } },
  );
  const json = await response.json();

  const items: ProductPoolItem[] = [];
  for (const product of json.data?.nodes ?? []) {
    if (!product) continue;
    for (const edge of product.variants?.edges ?? []) {
      const variant = edge.node;
      if (trimmedFilter && !(variant.title ?? "").toLowerCase().includes(trimmedFilter)) continue;
      const hasRealVariantTitle = variant.title && variant.title !== "Default Title";
      items.push({
        productId: product.id,
        variantId: variant.id,
        title: hasRealVariantTitle ? `${product.title} — ${variant.title}` : product.title,
        variantTitle: variant.title ?? "",
        image: variant.image?.url ?? product.featuredImage?.url ?? null,
        price: parseFloat(variant.price),
        available: variant.availableForSale,
        subtext: null,
        tags: product.tags ?? [],
      });
    }
  }

  await attachPoolItemSubtext(admin, items, subtextTemplate);
  return items;
}

/**
 * Resolves display data for an EXACT list of variant ids — no expansion to
 * sibling variants. Used for PRODUCTS-sourced ("Specific products") pools,
 * where the merchant already picked a specific variant per product and that
 * choice should be respected as-is. See fetchProductPoolItems for the
 * COLLECTIONS-sourced counterpart, which expands to every variant instead.
 */
export async function fetchVariantPoolItems(
  admin: AdminApiContext,
  variantIds: string[],
  subtextTemplate?: string | null,
): Promise<ProductPoolItem[]> {
  if (variantIds.length === 0) return [];

  const response = await admin.graphql(
    `#graphql
    query variantPoolItems($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          title
          price
          availableForSale
          image { url(transform: { maxWidth: 360, maxHeight: 360 }) }
          product {
            id
            title
            tags
            featuredImage { url(transform: { maxWidth: 360, maxHeight: 360 }) }
          }
        }
      }
    }`,
    { variables: { ids: variantIds } },
  );
  const json = await response.json();

  const items: ProductPoolItem[] = [];
  for (const variant of json.data?.nodes ?? []) {
    if (!variant || !variant.product) continue;
    const hasRealVariantTitle = variant.title && variant.title !== "Default Title";
    items.push({
      productId: variant.product.id,
      variantId: variant.id,
      title: hasRealVariantTitle ? `${variant.product.title} — ${variant.title}` : variant.product.title,
      variantTitle: variant.title ?? "",
      image: variant.image?.url ?? variant.product.featuredImage?.url ?? null,
      price: parseFloat(variant.price),
      available: variant.availableForSale,
      subtext: null,
      tags: variant.product.tags ?? [],
    });
  }

  await attachPoolItemSubtext(admin, items, subtextTemplate);
  return items;
}

/**
 * Creates (or reuses) the parent product for a FIXED bundle. The parent
 * variant carries a metafield listing component variants; the Cart Transform
 * function expands it into its components at checkout.
 */
export async function publishFixedBundleProduct(
  admin: AdminApiContext,
  input: FixedBundlePublishInput,
  existingProductId?: string | null,
) {
  const isMultiPack = input.packages.length > 1;

  // Snapshot component prices (across every package) so the Cart Transform
  // function can price each expanded package without a runtime lookup
  const allComponentVariantIds = Array.from(
    new Set(input.packages.flatMap((p) => p.componentVariantIds.map((c) => c.variantId))),
  );
  const priceResponse = await admin.graphql(
    `#graphql
    query componentPrices($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant { id price }
      }
    }`,
    { variables: { ids: allComponentVariantIds } },
  );
  const priceJson = await priceResponse.json();
  const priceByVariant = new Map<string, number>(
    (priceJson.data?.nodes ?? [])
      .filter(Boolean)
      .map((n: { id: string; price: string }) => [n.id, parseFloat(n.price)]),
  );

  // A component variant that no longer resolves means its product was deleted;
  // publishing anyway would ship a config the Cart Transform can't expand
  const missingVariantIds = allComponentVariantIds.filter((id) => !priceByVariant.has(id));
  if (missingVariantIds.length > 0) {
    const missingIds = new Set(missingVariantIds);
    const missingTitles = new Set(
      input.packages
        .flatMap((p) => p.displayItems)
        .filter((i) => i.variantId && missingIds.has(i.variantId))
        .map((i) => `"${i.title}"`),
    );
    throw new Error(
      `${Array.from(missingTitles).join(", ") || "Some products"} no longer exist in your store. Remove them from the bundle and save again.`,
    );
  }

  // Per-package price math — identical formula for every package, gifts are
  // always $0 and excluded from the bundle price allocation
  const packagePricing = input.packages.map((pkg) => {
    const titleByVariant = new Map(
      pkg.displayItems
        .filter((i): i is typeof i & { variantId: string } => Boolean(i.variantId))
        .map((i) => [i.variantId, i.title]),
    );
    const components = pkg.componentVariantIds.map((c) => ({
      variantId: c.variantId,
      quantity: c.quantity,
      isGift: c.isGift ?? false,
      price: c.isGift ? 0 : (priceByVariant.get(c.variantId) ?? 0),
      // Carried through so the Cart Transform function can label each
      // expanded cart line (it has no other way to look up titles)
      title: titleByVariant.get(c.variantId) ?? "",
    }));
    const combinedPrice =
      Math.round(components.reduce((sum, c) => sum + c.price * c.quantity, 0) * 100) / 100;

    let bundlePrice: number;
    if (pkg.pricingType === "FIXED_PRICE") {
      bundlePrice = pkg.pricingValue;
    } else if (pkg.pricingType === "PERCENT_OFF") {
      bundlePrice = combinedPrice * (1 - pkg.pricingValue / 100);
    } else {
      bundlePrice = Math.max(0, combinedPrice - pkg.pricingValue);
    }
    bundlePrice = Math.round(bundlePrice * 100) / 100;

    return { pkg, components, combinedPrice, bundlePrice };
  });

  let productId = existingProductId ?? null;

  if (!productId) {
    const createResponse = await admin.graphql(
      `#graphql
      mutation createBundleProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product { id }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          product: {
            title: input.title,
            descriptionHtml: input.description ?? "",
            tags: ["magyx-bundle"],
            status: "ACTIVE",
            // A single package publishes exactly like the original
            // single-config FIXED bundle: no product options, one default
            // variant. Multiple packages get one "Pack" option value each.
            ...(isMultiPack
              ? {
                  productOptions: [
                    {
                      name: PACK_OPTION_NAME,
                      values: input.packages.map((p) => ({ name: p.label })),
                    },
                  ],
                }
              : {}),
          },
        },
      },
    );
    const createJson = await createResponse.json();
    const createErrors = createJson.data?.productCreate?.userErrors ?? [];
    if (createErrors.length) {
      throw new Error(`Failed to create bundle product: ${JSON.stringify(createErrors)}`);
    }
    productId = createJson.data.productCreate.product.id;
    await setBundleProduct(input.bundleId, productId!);
  }

  const variantIdByPackageId = await resolvePackageVariants(admin, productId!, input.packages, isMultiPack);

  // One bulk update covering every package's variant: price, compare-at
  // price, and its own `$app:magyx-bundle/components` checkout-truth metafield
  const variantUpdates = packagePricing.map(({ pkg, components, combinedPrice, bundlePrice }) => ({
    id: variantIdByPackageId.get(pkg.packageId)!,
    price: bundlePrice.toFixed(2),
    // Combined component price as the strikethrough price; cleared when
    // there's no actual saving so themes don't show "$X $X"
    compareAtPrice: combinedPrice > bundlePrice ? combinedPrice.toFixed(2) : null,
    metafields: [
      {
        namespace: CONFIG_NAMESPACE,
        key: "components",
        type: "json",
        value: JSON.stringify({
          pricingType: pkg.pricingType,
          pricingValue: pkg.pricingValue,
          components,
          freeShipping: pkg.freeShipping,
        }),
      },
    ],
  }));

  const updateResponse = await admin.graphql(
    `#graphql
    mutation updateBundleVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id }
        userErrors { field message }
      }
    }`,
    { variables: { productId, variants: variantUpdates } },
  );
  const updateJson = await updateResponse.json();
  const updateErrors = updateJson.data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (updateErrors.length) {
    throw new Error(`Failed to update bundle variant: ${JSON.stringify(updateErrors)}`);
  }

  for (const pkg of input.packages) {
    await setPackageVariant(pkg.packageId, variantIdByPackageId.get(pkg.packageId)!);
  }

  // Display-only metafield the theme extension's Bundle Contents block renders
  // (numbered component cards on the product page). Uses an open namespace so
  // block Liquid can read it; checkout truth stays in each variant's metafield.
  // Soft-fails: a broken storefront card list shouldn't block saving.
  try {
    const allDisplayItems = input.packages.flatMap((p) => p.displayItems);
    const subtextTemplate = input.widgetSettings.itemSubtextTemplate.trim();
    let subtextByKey: Map<string, string> | null = null;
    if (subtextTemplate) {
      try {
        subtextByKey = await fetchItemSubtexts(admin, allDisplayItems, subtextTemplate);
      } catch (error) {
        console.warn("Magyx Bundle: could not resolve item subtext template", error);
      }
    }

    const displayItemsOf = (pkg: FixedBundlePackageInput) =>
      pkg.displayItems.map((item) => ({
        title: item.title,
        imageUrl: item.imageUrl,
        quantity: item.quantity,
        price: item.variantId ? (priceByVariant.get(item.variantId) ?? null) : null,
        isGift: item.isGift ?? false,
        subtext:
          item.isGift && !input.widgetSettings.showSubtextOnGifts
            ? null
            : subtextByKey?.get(item.variantId ?? item.productId) || null,
      }));

    // Single-package bundles keep today's flat shape so the storefront block
    // (and its own back-compat fallback for pre-package bundles) needs no
    // changes to render them; multi-package bundles get a `packages` array.
    const displayValue = isMultiPack
      ? {
          settings: input.widgetSettings,
          packages: input.packages.map((pkg) => ({
            variantId: variantIdByPackageId.get(pkg.packageId)!,
            label: pkg.label,
            badgeText: pkg.badgeText ?? null,
            badgeTone: pkg.badgeTone ?? null,
            freeShipping: pkg.freeShipping,
            items: displayItemsOf(pkg),
          })),
        }
      : {
          settings: { ...input.widgetSettings, freeShipping: input.packages[0]?.freeShipping ?? false },
          items: displayItemsOf(input.packages[0]),
        };

    const displayResponse = await admin.graphql(
      `#graphql
      mutation setBundleDisplayMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: productId,
              namespace: "magyx_bundle",
              key: "components",
              type: "json",
              value: JSON.stringify(displayValue),
            },
          ],
        },
      },
    );
    const displayErrors =
      (await displayResponse.json()).data?.metafieldsSet?.userErrors ?? [];
    if (displayErrors.length) {
      console.warn("Magyx Bundle: display metafield errors", displayErrors);
    }
  } catch (error) {
    console.warn("Magyx Bundle: could not set display metafield", error);
  }

  await publishProductToOnlineStore(admin, productId!);

  return productId;
}

interface ShopifyVariantNode {
  id: string;
  selectedOptions: { name: string; value: string }[];
}

// The subset of a package FIXED and SLOT_BUILDER both need for variant
// resolution — everything else (pricing, components, gifts) is type-specific
// and handled by each publish function on its own.
interface PackageVariantIdentity {
  packageId: string;
  existingVariantId?: string | null;
  label: string;
}

/**
 * Resolves each package to a Shopify variant id, creating/renaming/removing
 * "Pack" option values as needed so the product ends up with exactly one
 * variant per package. Matches packages to existing variants by the
 * previously-published variant id (not by label, which merchants can rename
 * freely) so editing a package in place never orphans its variant.
 */
async function resolvePackageVariants(
  admin: AdminApiContext,
  productId: string,
  packages: PackageVariantIdentity[],
  isMultiPack: boolean,
): Promise<Map<string, string>> {
  const fetchProduct = async () => {
    const response = await admin.graphql(
      `#graphql
      query bundleProductVariants($id: ID!) {
        product(id: $id) {
          options { id name optionValues { id name } }
          variants(first: 100) {
            edges { node { id selectedOptions { name value } } }
          }
        }
      }`,
      { variables: { id: productId } },
    );
    const json = await response.json();
    const product = json.data?.product;
    const variants: ShopifyVariantNode[] = (product?.variants?.edges ?? []).map(
      (e: { node: ShopifyVariantNode }) => e.node,
    );
    const packOption: { id: string; optionValues: { id: string; name: string }[] } | undefined = (
      product?.options ?? []
    ).find((o: { name: string }) => o.name === PACK_OPTION_NAME);
    return { variants, packOption };
  };

  if (!isMultiPack) {
    const { variants } = await fetchProduct();
    if (variants.length === 0) throw new Error("Bundle parent product has no variant");
    // Prefer the package's own previously-published variant so its id (and
    // the metafield we're about to write to it) survives the edit; fall
    // back to whichever variant Shopify returns first for a brand-new
    // product. Any other variants are leftovers from downgrading a
    // multi-package bundle back to one — safe to remove now that we know
    // which variant is staying.
    const preferredId = packages[0].existingVariantId;
    const keepVariant =
      (preferredId && variants.find((v) => v.id === preferredId)) || variants[0];
    const extraVariantIds = variants
      .filter((v) => v.id !== keepVariant.id)
      .map((v) => v.id);
    if (extraVariantIds.length > 0) {
      const deleteResponse = await admin.graphql(
        `#graphql
        mutation deleteBundleVariants($productId: ID!, $variantsIds: [ID!]!) {
          productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
            userErrors { field message }
          }
        }`,
        { variables: { productId, variantsIds: extraVariantIds } },
      );
      const deleteErrors =
        (await deleteResponse.json()).data?.productVariantsBulkDelete?.userErrors ?? [];
      if (deleteErrors.length) {
        throw new Error(`Failed to remove old package variants: ${JSON.stringify(deleteErrors)}`);
      }
    }
    return new Map([[packages[0].packageId, keepVariant.id]]);
  }

  let { variants, packOption } = await fetchProduct();

  // Create/rename/add pack option values FIRST, so replacement variants
  // always exist before any old ones are removed — deleting first (the
  // previous approach) could momentarily leave a product with zero variants
  // when every current package was new (e.g. activating a bundle that was
  // configured with multiple packages while still in Draft), which Shopify
  // rejects outright.
  if (!packOption) {
    const createOptionResponse = await admin.graphql(
      `#graphql
      mutation addPackOption($productId: ID!, $options: [OptionCreateInput!]!) {
        productOptionsCreate(productId: $productId, options: $options, variantStrategy: CREATE) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          productId,
          options: [{ name: PACK_OPTION_NAME, values: packages.map((p) => ({ name: p.label })) }],
        },
      },
    );
    const createOptionErrors =
      (await createOptionResponse.json()).data?.productOptionsCreate?.userErrors ?? [];
    if (createOptionErrors.length) {
      throw new Error(`Failed to create pack options: ${JSON.stringify(createOptionErrors)}`);
    }
  } else {
    const valueByVariantId = new Map<string, string>();
    for (const v of variants) {
      const value = v.selectedOptions.find((o) => o.name === PACK_OPTION_NAME)?.value;
      if (value) valueByVariantId.set(v.id, value);
    }
    const valueIdByName = new Map(packOption.optionValues.map((v) => [v.name, v.id]));
    // Value names that currently have a live variant attached — a package
    // whose label is in here needs nothing created (the variant is matched
    // up by label further down), even if our DB never recorded its variant
    // id (e.g. a previous publish failed partway through).
    const labelsWithVariant = new Set(valueByVariantId.values());

    const optionValuesToUpdate: { id: string; name: string }[] = [];
    const optionValuesToAdd: { name: string }[] = [];
    // Option values persist even after every variant using them is deleted
    // (e.g. a package was removed, then a later package reused that same
    // label) — reusing that leftover value's own id for a fresh variant
    // avoids re-adding a value name Shopify already has, which it rejects
    // outright ("Option value already exists").
    const orphanedValueIdsNeedingVariant: string[] = [];
    for (const pkg of packages) {
      const currentValue = pkg.existingVariantId ? valueByVariantId.get(pkg.existingVariantId) : undefined;
      if (currentValue && currentValue !== pkg.label) {
        const valueId = valueIdByName.get(currentValue);
        if (valueId) optionValuesToUpdate.push({ id: valueId, name: pkg.label });
      } else if (!currentValue && !labelsWithVariant.has(pkg.label)) {
        const existingValueId = valueIdByName.get(pkg.label);
        if (existingValueId) {
          orphanedValueIdsNeedingVariant.push(existingValueId);
        } else {
          // Genuinely new — no existing value with this name at all — needs
          // a value + variant created.
          optionValuesToAdd.push({ name: pkg.label });
        }
      }
    }

    if (optionValuesToUpdate.length > 0 || optionValuesToAdd.length > 0) {
      const updateOptionResponse = await admin.graphql(
        `#graphql
        mutation updatePackOption(
          $productId: ID!
          $option: OptionUpdateInput!
          $optionValuesToAdd: [OptionValueCreateInput!]
          $optionValuesToUpdate: [OptionValueUpdateInput!]
        ) {
          productOptionUpdate(
            productId: $productId
            option: $option
            optionValuesToAdd: $optionValuesToAdd
            optionValuesToUpdate: $optionValuesToUpdate
            variantStrategy: MANAGE
          ) {
            userErrors { field message }
          }
        }`,
        {
          variables: {
            productId,
            option: { id: packOption.id },
            optionValuesToAdd: optionValuesToAdd.length > 0 ? optionValuesToAdd : undefined,
            optionValuesToUpdate:
              optionValuesToUpdate.length > 0 ? optionValuesToUpdate : undefined,
          },
        },
      );
      const updateOptionErrors =
        (await updateOptionResponse.json()).data?.productOptionUpdate?.userErrors ?? [];
      if (updateOptionErrors.length) {
        throw new Error(`Failed to update pack options: ${JSON.stringify(updateOptionErrors)}`);
      }
    }

    if (orphanedValueIdsNeedingVariant.length > 0) {
      const createVariantsResponse = await admin.graphql(
        `#graphql
        mutation createBundleVariantsForExistingValues(
          $productId: ID!
          $variants: [ProductVariantsBulkInput!]!
        ) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            userErrors { field message }
          }
        }`,
        {
          variables: {
            productId,
            variants: orphanedValueIdsNeedingVariant.map((valueId) => ({
              optionValues: [{ optionId: packOption.id, id: valueId }],
            })),
          },
        },
      );
      const createVariantsErrors =
        (await createVariantsResponse.json()).data?.productVariantsBulkCreate?.userErrors ?? [];
      if (createVariantsErrors.length) {
        throw new Error(
          `Failed to create variants for existing pack options: ${JSON.stringify(createVariantsErrors)}`,
        );
      }
    }
  }

  // Re-fetch: option mutations above may have created/renamed variants
  ({ variants } = await fetchProduct());

  // Now it's safe to remove variants for packages no longer present — every
  // current package is guaranteed a matching variant at this point, so the
  // product always has at least one variant left after this runs.
  const desiredLabels = new Set(packages.map((p) => p.label));
  const variantsToDelete = variants.filter((v) => {
    const value = v.selectedOptions.find((o) => o.name === PACK_OPTION_NAME)?.value;
    return !value || !desiredLabels.has(value);
  });
  if (variantsToDelete.length > 0) {
    const deleteResponse = await admin.graphql(
      `#graphql
      mutation deleteBundleVariants($productId: ID!, $variantsIds: [ID!]!) {
        productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
          userErrors { field message }
        }
      }`,
      { variables: { productId, variantsIds: variantsToDelete.map((v) => v.id) } },
    );
    const deleteErrors =
      (await deleteResponse.json()).data?.productVariantsBulkDelete?.userErrors ?? [];
    if (deleteErrors.length) {
      throw new Error(`Failed to remove old package variants: ${JSON.stringify(deleteErrors)}`);
    }
    variants = variants.filter((v) => !variantsToDelete.includes(v));
  }

  const variantByPackValue = new Map<string, string>();
  for (const v of variants) {
    const value = v.selectedOptions.find((o) => o.name === PACK_OPTION_NAME)?.value;
    if (value) variantByPackValue.set(value, v.id);
  }

  const variantIdByPackageId = new Map<string, string>();
  for (const pkg of packages) {
    const variantId = variantByPackValue.get(pkg.label);
    if (!variantId) {
      throw new Error(`Could not resolve a Shopify variant for package "${pkg.label}".`);
    }
    variantIdByPackageId.set(pkg.packageId, variantId);
  }
  return variantIdByPackageId;
}

// One purchase option under a Bundle Builder bundle (e.g. "50ml" / "100ml").
// Unlike a FIXED package, there are no paid components to snapshot — the
// customer's slot picks aren't known until checkout — so a package carries
// its own price, slot count, product pool, and whatever fixed free gifts
// ship alongside it. Each package's pool is independent of the others.
interface SlotBuilderPackageInput {
  packageId: string;
  existingVariantId?: string | null;
  label: string;
  badgeText?: string | null;
  badgeTone?: string | null;
  pricingValue: number; // always FIXED_PRICE
  freeShipping: boolean;
  poolSource: string; // PRODUCTS | COLLECTIONS
  slotCount: number;
  // PRODUCTS-sourced pool variant ids — used to compute this package's
  // compare-at price (average pool item price × slot count), and to resolve
  // the exact-variant storefront pool snapshot below (no expansion to
  // sibling variants, since the merchant already chose a specific one).
  // Empty when COLLECTIONS-sourced — averaging over a whole collection isn't
  // worth a live resolve + bulk price fetch at publish time, so those
  // packages just get no compare-at price, same as the admin editor's own
  // preview; their snapshot instead resolves (a capped number of)
  // collectionIds and expands every variant, since there's no merchant-picked
  // variant to respect there.
  poolVariantIds: string[];
  collectionIds: string[];
  // COLLECTIONS-sourced pools only: case-insensitive substring match against
  // each variant's own title, applied when resolving the snapshot below.
  variantFilter: string;
  // Storefront pool-modal filter chips — button text + the exact product tag
  // each one matches. Display-only: baked into the display metafield for the
  // widget, never enforced at checkout.
  tagFilters: { label: string; tag: string }[];
  // This package's label/badge/chip copy per storefront locale. The fields
  // above stay the primary-locale copy the widget falls back to.
  translations: PackageTranslations;
  gifts: { variantId: string; quantity: number }[];
  // Denormalized gift info for the storefront widget's gift display
  giftDisplayItems: {
    title: string;
    imageUrl: string | null;
    quantity: number;
    productId: string;
    variantId: string | null;
  }[];
}

interface SlotBuilderPublishInput {
  bundleId: string;
  title: string;
  description?: string | null;
  packages: SlotBuilderPackageInput[];
  widgetSettings: {
    heading: string;
    accentColor: string;
    showPrices: boolean;
    skipCart: boolean;
    itemSubtextTemplate: string;
    showSubtextOnGifts: boolean;
  };
  // Widget copy the merchant translated, by locale then string key (see
  // app/utils/slot-builder-text.ts). The reserved "heading" key holds
  // per-locale versions of `widgetSettings.heading`.
  translations: SlotBuilderTranslations;
  // The shop's primary storefront locale — the widget falls back to this
  // bucket before falling back to its own built-in English defaults, so a
  // merchant whose default copy is German gets German on unlisted markets.
  primaryLocale: string;
}

export interface ShopLocale {
  /** IETF tag as Shopify reports it, e.g. "en", "fr", "pt-BR". */
  locale: string;
  name: string;
  primary: boolean;
}

/**
 * The shop's published storefront languages, primary first. Drives the
 * language switcher in the bundle editor's translations card, and tells the
 * storefront widget which bucket to fall back to. Unpublished locales are
 * dropped: a merchant can't show them to shoppers yet, so offering fields
 * for them is just clutter.
 *
 * Soft-fails to a single "en" primary — a locale lookup hiccup should cost
 * the merchant the translation UI, not the whole bundle editor.
 */
export async function fetchShopLocales(admin: AdminApiContext): Promise<ShopLocale[]> {
  try {
    const response = await admin.graphql(
      `#graphql
      query magyxShopLocales {
        shopLocales(published: true) { locale name primary }
      }`,
    );
    const locales = (await response.json()).data?.shopLocales ?? [];
    if (locales.length === 0) return [{ locale: "en", name: "English", primary: true }];
    return [...locales].sort(
      (a: ShopLocale, b: ShopLocale) => Number(b.primary) - Number(a.primary),
    );
  } catch (error) {
    console.warn("Magyx Bundle: could not load shop locales", error);
    return [{ locale: "en", name: "English", primary: true }];
  }
}

/* Translations go into a metafield that also carries a (capped, but not
   small) pool snapshot and ships on every product page render, so only keys
   the merchant actually filled in are baked. Blanks are dropped rather than
   written as empty strings: at read time the widget treats a missing key as
   "fall back to the primary locale, then to my built-in default", which is
   what an untouched field is meant to do. A locale left entirely blank
   disappears with it. */
function pruneTranslations(
  translations: SlotBuilderTranslations | undefined,
): SlotBuilderTranslations {
  const pruned: SlotBuilderTranslations = {};
  for (const [locale, strings] of Object.entries(translations ?? {})) {
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(strings ?? {})) {
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (trimmed) kept[key] = trimmed;
    }
    if (Object.keys(kept).length > 0) pruned[locale] = kept;
  }
  return pruned;
}

function prunePackageTranslations(
  translations: PackageTranslations | undefined,
): PackageTranslations {
  const pruned: PackageTranslations = {};
  for (const [locale, entry] of Object.entries(translations ?? {})) {
    const label = entry?.label?.trim() || "";
    const badgeText = entry?.badgeText?.trim() || "";
    // Kept as a positional array against the package's own `tagFilters`, so
    // an untranslated chip in the middle has to survive as "" rather than
    // collapsing and shifting every later chip onto the wrong filter.
    const tagFilterLabels = (entry?.tagFilterLabels ?? []).map((value) =>
      typeof value === "string" ? value.trim() : "",
    );
    const hasChipLabels = tagFilterLabels.some(Boolean);
    if (!label && !badgeText && !hasChipLabels) continue;
    pruned[locale] = {
      ...(label ? { label } : {}),
      ...(badgeText ? { badgeText } : {}),
      ...(hasChipLabels ? { tagFilterLabels } : {}),
    };
  }
  return pruned;
}

/**
 * Publishes/updates a SLOT_BUILDER bundle's parent Shopify product — one
 * variant per package (bottle size, pack size, ...), each priced at that
 * package's flat price (plus an optional compare-at price averaged from its
 * own PRODUCTS-sourced pool). No components are baked in: the customer's
 * slot picks are supplied by the storefront at add-to-cart time and
 * validated against that package's own pool by the Cart Transform function
 * (see syncBundleConfigMetafield's per-package `slotPoolProductIds`), not by
 * anything set here.
 */
export async function publishSlotBuilderBundleProduct(
  admin: AdminApiContext,
  input: SlotBuilderPublishInput,
  existingProductId?: string | null,
) {
  const isMultiPack = input.packages.length > 1;

  // Gift variants must still resolve — a broken gift would silently ship an
  // empty freebie at checkout — so a missing one hard-fails the publish, same
  // as FIXED's component snapshot. Pool variants are only looked up for the
  // compare-at average below; a deleted pool product just drops out of that
  // average rather than blocking the save (the storefront proxy route
  // already filters unresolvable pool items out at request time).
  const allGiftVariantIds = Array.from(
    new Set(input.packages.flatMap((p) => p.gifts.map((g) => g.variantId))),
  );
  const allPoolVariantIds = Array.from(new Set(input.packages.flatMap((p) => p.poolVariantIds)));
  const allPriceLookupIds = Array.from(new Set([...allGiftVariantIds, ...allPoolVariantIds]));
  let priceByVariant = new Map<string, number>();
  if (allPriceLookupIds.length > 0) {
    const priceResponse = await admin.graphql(
      `#graphql
      query slotBuilderVariantPrices($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant { id price }
        }
      }`,
      { variables: { ids: allPriceLookupIds } },
    );
    const priceJson = await priceResponse.json();
    priceByVariant = new Map<string, number>(
      (priceJson.data?.nodes ?? [])
        .filter(Boolean)
        .map((n: { id: string; price: string }) => [n.id, parseFloat(n.price)]),
    );
    const missingGiftVariantIds = allGiftVariantIds.filter((id) => !priceByVariant.has(id));
    if (missingGiftVariantIds.length > 0) {
      const missingIds = new Set(missingGiftVariantIds);
      const missingTitles = new Set(
        input.packages
          .flatMap((p) => p.giftDisplayItems)
          .filter((i) => i.variantId && missingIds.has(i.variantId))
          .map((i) => `"${i.title}"`),
      );
      throw new Error(
        `${Array.from(missingTitles).join(", ") || "Some free gift products"} no longer exist in your store. Remove them from the bundle and save again.`,
      );
    }
  }

  let productId = existingProductId ?? null;

  if (!productId) {
    const createResponse = await admin.graphql(
      `#graphql
      mutation createSlotBuilderProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product { id }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          product: {
            title: input.title,
            descriptionHtml: input.description ?? "",
            tags: ["magyx-bundle"],
            status: "ACTIVE",
            ...(isMultiPack
              ? {
                  productOptions: [
                    {
                      name: PACK_OPTION_NAME,
                      values: input.packages.map((p) => ({ name: p.label })),
                    },
                  ],
                }
              : {}),
          },
        },
      },
    );
    const createJson = await createResponse.json();
    const createErrors = createJson.data?.productCreate?.userErrors ?? [];
    if (createErrors.length) {
      throw new Error(`Failed to create bundle product: ${JSON.stringify(createErrors)}`);
    }
    productId = createJson.data.productCreate.product.id;
    await setBundleProduct(input.bundleId, productId!);
  }

  const variantIdByPackageId = await resolvePackageVariants(
    admin,
    productId!,
    input.packages.map((p) => ({
      packageId: p.packageId,
      existingVariantId: p.existingVariantId,
      label: p.label,
    })),
    isMultiPack,
  );

  // Mirrors the admin editor's own preview math exactly: average price of
  // this package's (PRODUCTS-sourced) pool items, times its slot count.
  const combinedPriceByPackageId = new Map<string, number>();
  for (const pkg of input.packages) {
    if (pkg.poolSource !== "PRODUCTS") continue;
    const pricedPoolItems = pkg.poolVariantIds
      .map((id) => priceByVariant.get(id))
      .filter((price): price is number => price != null);
    if (pricedPoolItems.length === 0) continue;
    const average = pricedPoolItems.reduce((sum, price) => sum + price, 0) / pricedPoolItems.length;
    combinedPriceByPackageId.set(
      pkg.packageId,
      Math.round(average * pkg.slotCount * 100) / 100,
    );
  }

  // Free shipping inherits forward across packages, exactly like free gifts:
  // once a package enables it, every bigger one keeps it. `input.packages` is
  // in position (tab) order, so a running flag is all this needs. Kept in
  // step with syncBundleConfigMetafield's cumulativeFreeShippingByPackage.
  let freeShippingSoFar = false;
  const cumulativeFreeShipping = input.packages.map((pkg) => {
    freeShippingSoFar = freeShippingSoFar || pkg.freeShipping;
    return freeShippingSoFar;
  });

  const variantUpdates = input.packages.map((pkg, index) => {
    const combinedPrice = combinedPriceByPackageId.get(pkg.packageId) ?? 0;
    return {
      id: variantIdByPackageId.get(pkg.packageId)!,
      price: pkg.pricingValue.toFixed(2),
      // Cleared when there's no actual saving so themes don't show "$X $X"
      compareAtPrice: combinedPrice > pkg.pricingValue ? combinedPrice.toFixed(2) : null,
      // The free-shipping Discount Function reads `freeShipping` off this
      // metafield (see extensions/magyx-free-shipping/src/run.js) — it can't
      // use the `_magyx_free_shipping` attribute the Cart Transform stamps,
      // because a discount function sees the cart as it was *before* the
      // transform's expand ran. Deliberately carries NO `components` array:
      // the Cart Transform expands any line whose variant has one, and a
      // Bundle Builder line must instead go through the slot-selection path
      // that validates the customer's picks against the package's pool.
      // Written on every publish (not just when enabled) so turning the
      // toggle back off clears the previously-published `true`.
      metafields: [
        {
          namespace: CONFIG_NAMESPACE,
          key: "components",
          type: "json",
          value: JSON.stringify({ freeShipping: cumulativeFreeShipping[index] }),
        },
      ],
    };
  });

  const updateResponse = await admin.graphql(
    `#graphql
    mutation updateSlotBuilderVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id }
        userErrors { field message }
      }
    }`,
    { variables: { productId, variants: variantUpdates } },
  );
  const updateJson = await updateResponse.json();
  const updateErrors = updateJson.data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (updateErrors.length) {
    throw new Error(`Failed to update bundle variant: ${JSON.stringify(updateErrors)}`);
  }

  for (const pkg of input.packages) {
    await setPackageVariant(pkg.packageId, variantIdByPackageId.get(pkg.packageId)!);
  }

  // Display-only metafield the theme's Bundle Builder block reads to find the
  // bundle id, slot count, package tabs, and appearance settings. It also
  // carries a bounded snapshot (POOL_SNAPSHOT_LIMIT items per package) of
  // each package's own pool, baked in at publish time — this bundle's
  // products only, never the merchant's wider catalog/collection — so the
  // widget can render immediately and keep working even if the storefront's
  // live app-proxy fetch fails; that fetch remains the source of truth for
  // the full pool and any price/stock changes since the last publish (a
  // collection-scoped pool can change without a republish). Soft-fails: a
  // broken storefront card list shouldn't block saving.
  try {
    const subtextTemplate = input.widgetSettings.itemSubtextTemplate.trim();
    const allGiftDisplayItems = input.packages.flatMap((p) => p.giftDisplayItems);
    let subtextByKey: Map<string, string> | null = null;
    if (subtextTemplate && input.widgetSettings.showSubtextOnGifts && allGiftDisplayItems.length > 0) {
      try {
        subtextByKey = await fetchItemSubtexts(admin, allGiftDisplayItems, subtextTemplate);
      } catch (error) {
        console.warn("Magyx Bundle: could not resolve item subtext template", error);
      }
    }

    const poolSnapshotsByPackage = await Promise.all(
      input.packages.map(async (pkg) => {
        try {
          if (pkg.poolSource === "PRODUCTS") {
            // Respect exactly the variant(s) the merchant picked — no
            // expansion to sibling variants, same as the live proxy fetch.
            const variantIds = Array.from(new Set(pkg.poolVariantIds)).slice(0, POOL_SNAPSHOT_LIMIT);
            return await fetchVariantPoolItems(admin, variantIds, subtextTemplate);
          }
          // COLLECTIONS-sourced: no merchant-picked variant to respect, so
          // every variant of every product is pickable. fetchProductPoolItems
          // returns one entry per variant, so a multi-variant catalog can
          // yield more items than productIds had entries — re-cap the
          // flattened result to keep the snapshot's page-weight bounded
          // regardless of variant count per product.
          const productIds = (
            await resolveCollectionProductIds(admin, pkg.collectionIds, POOL_SNAPSHOT_LIMIT)
          ).slice(0, POOL_SNAPSHOT_LIMIT);
          const items = await fetchProductPoolItems(
            admin,
            productIds,
            subtextTemplate,
            pkg.variantFilter,
          );
          return items.slice(0, POOL_SNAPSHOT_LIMIT);
        } catch (error) {
          console.warn("Magyx Bundle: could not resolve pool snapshot for package", pkg.packageId, error);
          return [];
        }
      }),
    );

    const displayValue = {
      bundleId: input.bundleId,
      settings: {
        ...input.widgetSettings,
        // Storefront copy the merchant translated. `heading` lives inside
        // `text` per locale rather than beside `settings.heading` so the
        // widget resolves it through the same lookup as every other string.
        primaryLocale: input.primaryLocale,
        text: pruneTranslations(input.translations),
      },
      packages: input.packages.map((pkg, index) => ({
        variantId: variantIdByPackageId.get(pkg.packageId)!,
        label: pkg.label,
        badgeText: pkg.badgeText ?? null,
        badgeTone: pkg.badgeTone ?? null,
        // Per-locale overrides for this package's own copy — the widget
        // falls back to the three fields above when a locale has no entry.
        translations: prunePackageTranslations(pkg.translations),
        price: pkg.pricingValue,
        slotCount: pkg.slotCount,
        freeShipping: pkg.freeShipping,
        tagFilters: pkg.tagFilters,
        poolSnapshot: poolSnapshotsByPackage[index],
        // A package's OWN gifts only — the widget builds the progressive
        // view itself (this package's gifts unlocked, later packages' gifts
        // locked), keyed by variantId to match checkout's cumulative merge.
        gifts: pkg.giftDisplayItems.map((item) => ({
          variantId: item.variantId,
          title: item.title,
          imageUrl: item.imageUrl,
          quantity: item.quantity,
          price: item.variantId ? (priceByVariant.get(item.variantId) ?? null) : null,
          subtext: subtextByKey?.get(item.variantId ?? item.productId) || null,
        })),
      })),
    };

    const displayResponse = await admin.graphql(
      `#graphql
      mutation setSlotBuilderDisplayMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: productId,
              namespace: "magyx_bundle",
              key: "slot_builder",
              type: "json",
              value: JSON.stringify(displayValue),
            },
          ],
        },
      },
    );
    const displayErrors =
      (await displayResponse.json()).data?.metafieldsSet?.userErrors ?? [];
    if (displayErrors.length) {
      console.warn("Magyx Bundle: slot builder display metafield errors", displayErrors);
    }
  } catch (error) {
    console.warn("Magyx Bundle: could not set slot builder display metafield", error);
  }

  await publishProductToOnlineStore(admin, productId!);

  return productId;
}
