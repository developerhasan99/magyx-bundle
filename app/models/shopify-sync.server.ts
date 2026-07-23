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
  };
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
    const displayValue = {
      settings: input.widgetSettings,
      items: input.displayItems.map((item) => ({
        title: item.title,
        imageUrl: item.imageUrl,
        quantity: item.quantity,
        price: item.variantId ? (priceByVariant.get(item.variantId) ?? null) : null,
        isGift: item.isGift ?? false,
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
