import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { fetchProductPoolItems, resolveCollectionProductIds } from "../models/shopify-sync.server";

/**
 * On-demand resource route for the Bundle Builder editor's "Resolve
 * products" button — resolving every variant of every product in a
 * collection is uncapped by design (see resolveCollectionPoolItems in
 * app.bundles.$id/route.tsx's loader), so it's deliberately NOT run
 * automatically on every page load. The merchant triggers it explicitly
 * instead, only for the package they're actively editing.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const collectionIds = JSON.parse(String(formData.get("collectionIds") ?? "[]")) as string[];
  const variantFilter = String(formData.get("variantFilter") ?? "");
  const itemSubtextTemplate = String(formData.get("itemSubtextTemplate") ?? "");

  try {
    const productIds = await resolveCollectionProductIds(admin, collectionIds);
    const items = await fetchProductPoolItems(admin, productIds, itemSubtextTemplate, variantFilter);
    return json({
      items: items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        title: item.title,
        imageUrl: item.image,
        price: item.price,
        available: item.available,
      })),
    });
  } catch (error) {
    console.warn("Magyx Bundle: could not resolve collection pool", error);
    return json({ items: [], error: "Could not resolve products from the selected collection(s)." });
  }
};
