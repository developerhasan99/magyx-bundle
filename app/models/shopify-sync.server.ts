import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { getBundles, setBundleProduct, setPackageVariant } from "./bundle.server";

const CONFIG_NAMESPACE = "$app:magyx-bundle";
const CONFIG_KEY = "config";

/**
 * Publishes all ACTIVE bundles for the shop into an app-owned shop metafield.
 * The Cart Transform function reads this metafield to price mix & match
 * bundles and validate fixed bundles at checkout — server-side truth, so the
 * storefront can never tamper with discounts.
 */
export async function syncBundleConfigMetafield(admin: AdminApiContext, shop: string) {
  const bundles = await getBundles(shop);
  const active = bundles.filter((b) => b.status === "ACTIVE");

  const config = {
    bundles: active.map((b) => ({
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
      rule: b.rule
        ? {
            minItems: b.rule.minItems,
            maxItems: b.rule.maxItems,
            discountTiers: JSON.parse(b.rule.discountTiers),
            collectionIds: JSON.parse(b.rule.collectionIds),
          }
        : null,
    })),
  };

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
async function fetchItemSubtexts(
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
  packages: FixedBundlePackageInput[],
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
    const currentLabels = new Set(valueByVariantId.values());

    const optionValuesToUpdate: { id: string; name: string }[] = [];
    const optionValuesToAdd: { name: string }[] = [];
    for (const pkg of packages) {
      const currentValue = pkg.existingVariantId ? valueByVariantId.get(pkg.existingVariantId) : undefined;
      if (currentValue && currentValue !== pkg.label) {
        const valueId = valueIdByName.get(currentValue);
        if (valueId) optionValuesToUpdate.push({ id: valueId, name: pkg.label });
      } else if (!currentValue && !currentLabels.has(pkg.label)) {
        // Not tracked by variant id and no existing value already matches
        // this label (e.g. a product just created with this exact set of
        // pack labels) — genuinely new, needs a value + variant created.
        optionValuesToAdd.push({ name: pkg.label });
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
            variantStrategy: CREATE
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
