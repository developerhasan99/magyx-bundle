import { json as jsonResponse, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getActiveQuantityBreakBundles } from "../models/bundle.server";

/**
 * App proxy endpoint: storefront requests to
 * /apps/magyx-bundle/quantity-breaks/:productId (a plain numeric product id,
 * straight from Liquid's `product.id`) are forwarded here by Shopify with an
 * HMAC signature that authenticate.public.appProxy verifies. Resolves
 * whether that product has an active QUANTITY_BREAKS bundle and, if so,
 * returns its tiers plus live variant data for the widget — keyed purely by
 * product id, no bundle id is ever exposed to the storefront for this type.
 *
 * Unlike the Cart Transform function (which can only match a pre-resolved
 * product id list), this route has full Admin API access, so ALL/COLLECTIONS
 * scope is always resolved live here — no staleness between bundle saves.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  const productGid = `gid://shopify/Product/${params.productId}`;
  const bundles = await getActiveQuantityBreakBundles(session.shop);

  // Priority: an explicit product match wins, then a collection match, then
  // an ALL-scope bundle as the store-wide fallback — mirrors the Cart
  // Transform function's own priority so the widget and checkout agree.
  let bundle =
    bundles.find(
      (b) => b.quantityBreakScope === "PRODUCTS" && b.items.some((i) => i.productId === productGid),
    ) ?? null;

  if (!bundle) {
    const collectionsScoped = bundles.filter((b) => b.quantityBreakScope === "COLLECTIONS");
    if (collectionsScoped.length > 0) {
      const collectionsResponse = await admin.graphql(
        `#graphql
        query quantityBreakProductCollections($id: ID!) {
          product(id: $id) {
            collections(first: 250) { edges { node { id } } }
          }
        }`,
        { variables: { id: productGid } },
      );
      const collectionsJson = await collectionsResponse.json();
      const productCollectionIds = new Set<string>(
        (collectionsJson.data?.product?.collections?.edges ?? []).map(
          (edge: { node: { id: string } }) => edge.node.id,
        ),
      );
      bundle =
        collectionsScoped.find((b) => {
          const collectionIds: string[] = b.rule ? JSON.parse(b.rule.collectionIds) : [];
          return collectionIds.some((id) => productCollectionIds.has(id));
        }) ?? null;
    }
  }

  if (!bundle) {
    bundle = bundles.find((b) => b.quantityBreakScope === "ALL") ?? null;
  }

  if (!bundle) {
    return jsonResponse({ error: "Not found" }, { status: 404 });
  }

  const response = await admin.graphql(
    `#graphql
    query quantityBreakProduct($id: ID!) {
      product(id: $id) {
        title
        options { name optionValues { name } }
        variants(first: 100) {
          edges {
            node {
              id
              title
              price
              compareAtPrice
              availableForSale
              image { url(transform: { maxWidth: 200, maxHeight: 200 }) }
              selectedOptions { name value }
            }
          }
        }
      }
    }`,
    { variables: { id: productGid } },
  );
  const json = await response.json();
  const product = json.data?.product;
  if (!product) {
    return jsonResponse({ error: "Not found" }, { status: 404 });
  }

  const variants = (product.variants?.edges ?? []).map(
    (edge: {
      node: {
        id: string;
        title: string;
        price: string;
        compareAtPrice: string | null;
        availableForSale: boolean;
        image?: { url: string } | null;
        selectedOptions: { name: string; value: string }[];
      };
    }) => ({
      id: edge.node.id.replace("gid://shopify/ProductVariant/", ""),
      title: edge.node.title,
      price: parseFloat(edge.node.price),
      compareAtPrice: edge.node.compareAtPrice ? parseFloat(edge.node.compareAtPrice) : null,
      available: edge.node.availableForSale,
      image: edge.node.image?.url ?? null,
      selectedOptions: edge.node.selectedOptions,
    }),
  );

  return jsonResponse(
    {
      bundleId: bundle.id,
      heading: bundle.widgetHeading,
      accentColor: bundle.accentColor,
      tiers: bundle.tiers.map((t) => ({
        quantity: t.quantity,
        label: t.label,
        badgeText: t.badgeText,
        badgeTone: t.badgeTone,
        pricingType: t.pricingType,
        pricingValue: t.pricingValue,
        isDefault: t.isDefault,
        // Denormalized at save time in the admin — no live lookup needed,
        // same convention as the Bundle Contents block's display metafield.
        gifts: t.items.map((i) => ({
          title: i.productTitle,
          image: i.productImageUrl,
          quantity: i.quantity,
        })),
      })),
      product: {
        title: product.title,
        options: product.options ?? [],
        variants,
      },
    },
    {
      headers: { "Cache-Control": "public, max-age=60" },
    },
  );
};
