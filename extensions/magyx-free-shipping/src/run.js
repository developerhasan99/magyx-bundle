// @ts-check

/**
 * Magyx Free Shipping
 *
 * Waives shipping whenever the cart contains a line stamped with the
 * `_magyx_free_shipping` attribute — set by the bundle-pricing Cart Transform
 * function on a bundle's expanded lines when the bundle has free shipping
 * enabled (see buildExpandOperation in extensions/bundle-pricing/src/run.js).
 * The attribute's mere presence is enough; there's no need to know which
 * bundle it came from.
 */

const NO_CHANGES = { operations: [] };

export function cartDeliveryOptionsDiscountsGenerateRun(input) {
  if (!input.discount.discountClasses.includes("SHIPPING")) return NO_CHANGES;

  const hasFreeShippingAttribute = input.cart.lines.some(
    (line) => line.attribute?.value === "true",
  );
  if (!hasFreeShippingAttribute) return NO_CHANGES;

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
