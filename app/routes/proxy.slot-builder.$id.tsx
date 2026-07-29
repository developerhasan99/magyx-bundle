import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getBundle } from "../models/bundle.server";
import { fetchProductPoolItems, resolveCollectionProductIds } from "../models/shopify-sync.server";

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
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const bundle = await getBundle(session.shop, params.id!);
  if (!bundle || bundle.status !== "ACTIVE" || bundle.type !== "SLOT_BUILDER") {
    return json({ error: "Bundle not found" }, { status: 404 });
  }

  const productIdsByPackage = await Promise.all(
    bundle.packages.map(async (pkg) => {
      const poolItems = pkg.items.filter((i) => !i.isGift);
      if (poolItems.length > 0) return poolItems.map((i) => i.productId);
      return resolveCollectionProductIds(admin, JSON.parse(pkg.collectionIds) as string[]);
    }),
  );

  const allProductIds = Array.from(new Set(productIdsByPackage.flat()));
  const poolDisplayItems = await fetchProductPoolItems(admin, allProductIds, bundle.itemSubtextTemplate);
  const productById = new Map(poolDisplayItems.map((item) => [item.productId, item]));

  return json(
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
