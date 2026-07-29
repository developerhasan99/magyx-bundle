import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getBundle } from "../models/bundle.server";
import {
  fetchProductPoolItems,
  fetchVariantPoolItems,
  resolveCollectionProductIds,
} from "../models/shopify-sync.server";

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

  // PRODUCTS-sourced packages keep exactly the variant(s) the merchant
  // picked — no expansion. COLLECTIONS-sourced packages have no
  // merchant-picked variant to respect, so every variant of every product
  // in the collection is pickable instead.
  const packageSources = bundle.packages.map((pkg) => {
    const poolItems = pkg.items.filter((i) => !i.isGift);
    if (poolItems.length > 0) {
      return {
        kind: "variants" as const,
        variantIds: poolItems.map((i) => i.variantId).filter((id): id is string => Boolean(id)),
      };
    }
    return { kind: "collection" as const, collectionIds: JSON.parse(pkg.collectionIds) as string[] };
  });

  const productIdsByPackage = await Promise.all(
    packageSources.map((source) =>
      source.kind === "collection"
        ? resolveCollectionProductIds(admin, source.collectionIds)
        : Promise.resolve([] as string[]),
    ),
  );

  const allVariantIds = Array.from(
    new Set(packageSources.flatMap((source) => (source.kind === "variants" ? source.variantIds : []))),
  );
  const allProductIds = Array.from(new Set(productIdsByPackage.flat()));

  const [variantItems, productItems] = await Promise.all([
    fetchVariantPoolItems(admin, allVariantIds, bundle.itemSubtextTemplate),
    fetchProductPoolItems(admin, allProductIds, bundle.itemSubtextTemplate),
  ]);

  const variantItemById = new Map(variantItems.map((item) => [item.variantId, item]));
  // Every variant of a COLLECTIONS pool product is pickable, so a product
  // can contribute more than one item here — group instead of a 1:1 map.
  const productItemsByProductId = new Map<string, typeof productItems>();
  for (const item of productItems) {
    const existing = productItemsByProductId.get(item.productId);
    if (existing) existing.push(item);
    else productItemsByProductId.set(item.productId, [item]);
  }

  return json(
    {
      id: bundle.id,
      packages: bundle.packages.map((pkg, index) => {
        const source = packageSources[index];
        const items =
          source.kind === "variants"
            ? source.variantIds
                .map((id) => variantItemById.get(id))
                .filter((item): item is NonNullable<typeof item> => Boolean(item))
            : productIdsByPackage[index].flatMap((id) => productItemsByProductId.get(id) ?? []);
        return { variantId: pkg.shopifyVariantId, items };
      }),
    },
    {
      headers: { "Cache-Control": "public, max-age=60" },
    },
  );
};
