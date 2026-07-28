import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getBundle } from "../models/bundle.server";
import { fetchItemSubtexts, resolveCollectionProductIds } from "../models/shopify-sync.server";

/**
 * App proxy endpoint: storefront requests to
 * /apps/magyx-bundle/slot-builder/:id are forwarded here by Shopify with an
 * HMAC signature that authenticate.public.appProxy verifies. Each package
 * (bottle size / pack size) has its own independent product pool, so this
 * returns live product data (price, image, availability) per package,
 * keyed by that package's Shopify variant id — the storefront widget already
 * has package labels/badges/gifts from the product's own display metafield
 * (baked at publish time), it just needs the pool refreshed live, since a
 * collection-scoped pool can change without a republish.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const bundle = await getBundle(session.shop, params.id!);
  if (!bundle || bundle.status !== "ACTIVE" || bundle.type !== "SLOT_BUILDER") {
    return Response.json({ error: "Bundle not found" }, { status: 404 });
  }

  const productIdsByPackage = await Promise.all(
    bundle.packages.map(async (pkg) => {
      const poolItems = pkg.items.filter((i) => !i.isGift);
      if (poolItems.length > 0) return poolItems.map((i) => i.productId);
      return resolveCollectionProductIds(admin, JSON.parse(pkg.collectionIds) as string[]);
    }),
  );

  const allProductIds = Array.from(new Set(productIdsByPackage.flat()));
  const productById = new Map<
    string,
    {
      productId: string;
      variantId: string;
      title: string;
      image: string | null;
      price: number;
      available: boolean;
      subtext: string | null;
    }
  >();
  if (allProductIds.length > 0) {
    const response = await admin.graphql(
      `#graphql
      query slotBuilderPoolProducts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            featuredImage { url(transform: { maxWidth: 360, maxHeight: 360 }) }
            variants(first: 1) {
              edges { node { id title price availableForSale } }
            }
          }
        }
      }`,
      { variables: { ids: allProductIds } },
    );
    const json = await response.json();
    for (const product of json.data?.nodes ?? []) {
      if (!product) continue;
      const variant = product.variants?.edges?.[0]?.node;
      if (!variant) continue;
      const hasRealVariantTitle = variant.title && variant.title !== "Default Title";
      productById.set(product.id, {
        productId: product.id,
        variantId: variant.id,
        title: hasRealVariantTitle ? `${product.title} — ${variant.title}` : product.title,
        image: product.featuredImage?.url ?? null,
        price: parseFloat(variant.price),
        available: variant.availableForSale,
        subtext: null,
      });
    }

    // Same "{{sku}}/{{vendor}}/{{metafield:...}}" template the admin sets
    // once per bundle for the Bundle Contents widget — reused here so pool
    // items and picks show the same subtext line. Soft-fails: a broken
    // template shouldn't blank out the pool.
    const subtextTemplate = bundle.itemSubtextTemplate?.trim();
    if (subtextTemplate) {
      try {
        const subtextByKey = await fetchItemSubtexts(
          admin,
          Array.from(productById.values()).map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
          })),
          subtextTemplate,
        );
        for (const item of productById.values()) {
          item.subtext = subtextByKey.get(item.variantId ?? item.productId) || null;
        }
      } catch (error) {
        console.warn("Magyx Bundle: could not resolve slot builder item subtext", error);
      }
    }
  }

  return Response.json(
    {
      id: bundle.id,
      packages: bundle.packages.map((pkg, index) => ({
        variantId: pkg.shopifyVariantId,
        items: productIdsByPackage[index]
          .map((id) => productById.get(id))
          .filter((item): item is NonNullable<typeof item> => Boolean(item)),
      })),
    },
    {
      headers: { "Cache-Control": "public, max-age=60" },
    },
  );
};
