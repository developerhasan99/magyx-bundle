import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getBundle } from "../models/bundle.server";
import {
  fetchProductPoolItems,
  fetchVariantPoolItems,
  localizePoolItemTitles,
  resolveCollectionProductIds,
} from "../models/shopify-sync.server";
import {
  parseTranslations,
  resolveSubtextTemplate,
  type SlotBuilderTranslations,
} from "../utils/slot-builder-text";

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

  // This response serves exactly one shopper's language, so the subtext is
  // resolved from that language's template (falling back to the bundle's own)
  // rather than carrying every locale the way the publish-time snapshot does.
  // Same `locale` query param the titles below are localized with — it's part
  // of the URL, so the Cache-Control at the bottom can't serve one language's
  // subtext to another.
  const locale = new URL(request.url).searchParams.get("locale");
  const subtextTemplate = resolveSubtextTemplate(
    parseTranslations<SlotBuilderTranslations>(bundle.translations, {}),
    // No primary-locale step: the admin only offers the subtext field on
    // non-primary languages (the primary one is the Storefront section's own
    // field), so there is never a primary-keyed entry to find, and asking
    // Shopify which locale is primary would cost a request per pool refresh.
    null,
    locale,
    bundle.itemSubtextTemplate,
  );

  const [variantItems, productItems] = await Promise.all([
    fetchVariantPoolItems(admin, allVariantIds, subtextTemplate),
    fetchProductPoolItems(admin, allProductIds, subtextTemplate),
  ]);

  // Product names live in the merchant's catalog, so they're translated in
  // Translate & Adapt, not in this app. The widget passes the storefront's
  // active language; one batched lookup rewrites both pools' titles into it.
  // Soft-fails inside the helper — untranslated titles beat an empty pool.
  // Safe to do before the variantFilter pass below: that matches on
  // `variantTitle`, which is never translated on purpose (see ProductPoolItem),
  // so a merchant's "50ml" filter keeps working in every language.
  await localizePoolItemTitles(admin, [...variantItems, ...productItems], locale);

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
        if (source.kind === "variants") {
          const items = source.variantIds
            .map((id) => variantItemById.get(id))
            .filter((item): item is NonNullable<typeof item> => Boolean(item));
          return { variantId: pkg.shopifyVariantId, items };
        }
        // The GraphQL fetch above is batched across every COLLECTIONS
        // package for efficiency, so each package's own variantFilter has to
        // be applied here, per-package, rather than inside that shared call.
        const allVariants = productIdsByPackage[index].flatMap(
          (id) => productItemsByProductId.get(id) ?? [],
        );
        const filter = pkg.variantFilter.trim().toLowerCase();
        const items = filter
          ? allVariants.filter((item) => item.variantTitle.toLowerCase().includes(filter))
          : allVariants;
        return { variantId: pkg.shopifyVariantId, items };
      }),
    },
    {
      headers: { "Cache-Control": "public, max-age=60" },
    },
  );
};
