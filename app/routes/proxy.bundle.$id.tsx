import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getBundle } from "../models/bundle.server";

/**
 * App proxy endpoint: storefront requests to /apps/magyx-bundle/bundle/:id are
 * forwarded here by Shopify with an HMAC signature that
 * authenticate.public.appProxy verifies. Returns the bundle definition plus
 * live product data (price, image, availability) for the mix & match widget.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const bundle = await getBundle(session.shop, params.id!);
  if (!bundle || bundle.status !== "ACTIVE" || bundle.type !== "MIX_MATCH") {
    return Response.json({ error: "Bundle not found" }, { status: 404 });
  }

  const productIds = bundle.items.map((i) => i.productId);
  const response = await admin.graphql(
    `#graphql
    query widgetProducts($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          handle
          featuredImage { url(transform: { maxWidth: 360, maxHeight: 360 }) }
          variants(first: 1) {
            edges { node { id price availableForSale } }
          }
        }
      }
    }`,
    { variables: { ids: productIds } },
  );
  const json = await response.json();

  const items = (json.data?.nodes ?? [])
    .filter(Boolean)
    .map((product: any) => {
      const variant = product.variants?.edges?.[0]?.node;
      if (!variant) return null;
      return {
        productId: product.id.replace("gid://shopify/Product/", ""),
        variantId: variant.id.replace("gid://shopify/ProductVariant/", ""),
        title: product.title,
        handle: product.handle,
        image: product.featuredImage?.url ?? null,
        price: parseFloat(variant.price),
        available: variant.availableForSale,
      };
    })
    .filter(Boolean);

  return Response.json(
    {
      id: bundle.id,
      title: bundle.title,
      description: bundle.description,
      minItems: bundle.rule?.minItems ?? 1,
      maxItems: bundle.rule?.maxItems ?? null,
      tiers: bundle.rule ? JSON.parse(bundle.rule.discountTiers) : [],
      items,
    },
    {
      headers: { "Cache-Control": "public, max-age=60" },
    },
  );
};
