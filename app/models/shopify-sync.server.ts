import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { getBundles, setBundleProduct } from "./bundle.server";

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
  if (active.some((b) => b.freeShipping)) {
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

interface FixedBundlePublishInput {
  bundleId: string;
  title: string;
  description?: string | null;
  pricingType: string;
  pricingValue: number;
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
  // Appearance of the storefront "what's inside" widget — set entirely from
  // the app admin, the theme block has no editable settings of its own
  widgetSettings: {
    style: string;
    heading: string;
    accentColor: string;
    showPrices: boolean;
    itemSubtextTemplate: string;
    showSubtextOnGifts: boolean;
    freeShipping: boolean;
  };
}

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
  // Snapshot component prices so the Cart Transform function can price the
  // expanded components without a runtime lookup
  const priceResponse = await admin.graphql(
    `#graphql
    query componentPrices($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant { id price }
      }
    }`,
    { variables: { ids: input.componentVariantIds.map((c) => c.variantId) } },
  );
  const priceJson = await priceResponse.json();
  const priceByVariant = new Map<string, number>(
    (priceJson.data?.nodes ?? [])
      .filter(Boolean)
      .map((n: { id: string; price: string }) => [n.id, parseFloat(n.price)]),
  );

  // A component variant that no longer resolves means its product was deleted;
  // publishing anyway would ship a config the Cart Transform can't expand
  const missingVariants = input.componentVariantIds.filter(
    (c) => !priceByVariant.has(c.variantId),
  );
  if (missingVariants.length > 0) {
    const missingIds = new Set(missingVariants.map((c) => c.variantId));
    const missingTitles = input.displayItems
      .filter((i) => i.variantId && missingIds.has(i.variantId))
      .map((i) => `"${i.title}"`);
    throw new Error(
      `${missingTitles.join(", ") || "Some products"} no longer exist in your store. Remove them from the bundle and save again.`,
    );
  }

  const titleByVariant = new Map(
    input.displayItems
      .filter((i): i is typeof i & { variantId: string } => Boolean(i.variantId))
      .map((i) => [i.variantId, i.title]),
  );
  const components = input.componentVariantIds.map((c) => ({
    variantId: c.variantId,
    quantity: c.quantity,
    isGift: c.isGift ?? false,
    // Gifts are always $0 — excluded from the bundle price allocation below,
    // regardless of their real catalog price (used only for display)
    price: c.isGift ? 0 : (priceByVariant.get(c.variantId) ?? 0),
    // Carried through so the Cart Transform function can label each expanded
    // cart line (it has no other way to look up product/variant titles)
    title: titleByVariant.get(c.variantId) ?? "",
  }));
  const combinedPrice =
    Math.round(
      components.reduce((sum, c) => sum + c.price * c.quantity, 0) * 100,
    ) / 100;

  let bundlePrice: number;
  if (input.pricingType === "FIXED_PRICE") {
    bundlePrice = input.pricingValue;
  } else if (input.pricingType === "PERCENT_OFF") {
    bundlePrice = combinedPrice * (1 - input.pricingValue / 100);
  } else {
    bundlePrice = Math.max(0, combinedPrice - input.pricingValue);
  }
  bundlePrice = Math.round(bundlePrice * 100) / 100;

  let productId = existingProductId ?? null;

  if (!productId) {
    const createResponse = await admin.graphql(
      `#graphql
      mutation createBundleProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            variants(first: 1) { edges { node { id } } }
          }
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

  const variantResponse = await admin.graphql(
    `#graphql
    query bundleProductVariant($id: ID!) {
      product(id: $id) { variants(first: 1) { edges { node { id } } } }
    }`,
    { variables: { id: productId } },
  );
  const variantJson = await variantResponse.json();
  const variantId =
    variantJson.data?.product?.variants?.edges?.[0]?.node?.id;
  if (!variantId) throw new Error("Bundle parent product has no variant");

  const updateResponse = await admin.graphql(
    `#graphql
    mutation updateBundleVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        productId,
        variants: [
          {
            id: variantId,
            price: bundlePrice.toFixed(2),
            // Combined component price as the strikethrough price; cleared
            // when there's no actual saving so themes don't show "$X $X"
            compareAtPrice:
              combinedPrice > bundlePrice ? combinedPrice.toFixed(2) : null,
            metafields: [
              {
                namespace: CONFIG_NAMESPACE,
                key: "components",
                type: "json",
                value: JSON.stringify({
                  pricingType: input.pricingType,
                  pricingValue: input.pricingValue,
                  components,
                  freeShipping: input.widgetSettings.freeShipping,
                }),
              },
            ],
          },
        ],
      },
    },
  );
  const updateJson = await updateResponse.json();
  const updateErrors =
    updateJson.data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (updateErrors.length) {
    throw new Error(`Failed to update bundle variant: ${JSON.stringify(updateErrors)}`);
  }

  // Display-only metafield the theme extension's Bundle Contents block renders
  // (numbered component cards on the product page). Uses an open namespace so
  // block Liquid can read it; checkout truth stays in the variant metafield.
  // Soft-fails: a broken storefront card list shouldn't block saving.
  try {
    const subtextTemplate = input.widgetSettings.itemSubtextTemplate.trim();
    let subtextByKey: Map<string, string> | null = null;
    if (subtextTemplate) {
      try {
        subtextByKey = await fetchItemSubtexts(admin, input.displayItems, subtextTemplate);
      } catch (error) {
        console.warn("Magyx Bundle: could not resolve item subtext template", error);
      }
    }

    const displayValue = {
      settings: input.widgetSettings,
      items: input.displayItems.map((item) => ({
        title: item.title,
        imageUrl: item.imageUrl,
        quantity: item.quantity,
        price: item.variantId ? (priceByVariant.get(item.variantId) ?? null) : null,
        isGift: item.isGift ?? false,
        subtext:
          item.isGift && !input.widgetSettings.showSubtextOnGifts
            ? null
            : subtextByKey?.get(item.variantId ?? item.productId) || null,
      })),
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
