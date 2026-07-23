// @ts-check
import { DiscountClass } from "../generated/api";

/**
 * Magyx Free Shipping
 *
 * Waives shipping whenever the cart contains a FIXED bundle whose merchant
 * enabled free shipping. Reads the `freeShipping` flag straight off the
 * bundle variant's `$app:magyx-bundle/components` metafield — the same
 * source the bundle-pricing Cart Transform function reads (see
 * buildExpandOperation in extensions/bundle-pricing/src/run.js) — rather than
 * a cart line attribute, because this function's `cart` input reflects the
 * cart as it existed before the Cart Transform's expand ran, so any
 * attribute the transform stamps onto its expanded lines isn't visible here.
 */

const NO_CHANGES = { operations: [] };

/** @param {import("../generated/api").RunInput} input */
export function cartDeliveryOptionsDiscountsGenerateRun(input) {
  if (!input.discount.discountClasses.includes(DiscountClass.Shipping)) return NO_CHANGES;

  const hasFreeShippingBundle = input.cart.lines.some((line) => {
    const merchandise = line.merchandise;
    const componentsValue =
      merchandise?.__typename === "ProductVariant" ? merchandise.components?.value : undefined;
    if (!componentsValue) return false;
    try {
      return JSON.parse(componentsValue)?.freeShipping === true;
    } catch {
      return false;
    }
  });
  if (!hasFreeShippingBundle) return NO_CHANGES;

  const deliveryGroups = input.cart.deliveryGroups;
  if (deliveryGroups.length === 0) return NO_CHANGES;

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          candidates: deliveryGroups.map((group) => ({
            message: "Free shipping gift",
            targets: [{ deliveryGroup: { id: group.id } }],
            value: { percentage: { value: 100 } },
          })),
          selectionStrategy: "ALL",
        },
      },
    ],
  };
}
