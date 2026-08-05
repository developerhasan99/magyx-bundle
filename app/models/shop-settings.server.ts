import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { sanitizeCustomCss } from "../utils/custom-css";

/** Storefront-visible shop metafield the theme block reads the CSS from.
    A plain namespace, not an app-reserved one, so Liquid can address it as
    `shop.metafields.magyx_bundle.custom_css` — the same namespace the
    product-level display metafields already use. */
const CSS_NAMESPACE = "magyx_bundle";
const CSS_KEY = "custom_css";

export async function getShopSettings(shop: string) {
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  return { customCss: settings?.customCss ?? "" };
}

/**
 * Saves the CSS and mirrors it to the shop metafield the storefront reads.
 *
 * The metafield write is what actually changes the storefront — the table is
 * just what the settings form reads back — so a failure there has to surface
 * rather than soft-fail, otherwise the merchant sees "saved" and nothing
 * changes on their site.
 */
export async function saveCustomCss(
  admin: AdminApiContext,
  shop: string,
  css: string,
): Promise<string> {
  const clean = sanitizeCustomCss(css);

  await prisma.shopSettings.upsert({
    where: { shop },
    create: { shop, customCss: clean },
    update: { customCss: clean },
  });

  const shopIdResponse = await admin.graphql(`#graphql
    query magyxShopId { shop { id } }`);
  const shopId = (await shopIdResponse.json()).data.shop.id;

  const response = await admin.graphql(
    `#graphql
    mutation setMagyxCustomCss($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: CSS_NAMESPACE,
            key: CSS_KEY,
            type: "multi_line_text_field",
            value: clean,
          },
        ],
      },
    },
  );
  const errors = (await response.json()).data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    throw new Error(`Failed to publish custom CSS: ${JSON.stringify(errors)}`);
  }

  return clean;
}
