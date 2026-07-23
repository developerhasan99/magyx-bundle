// @ts-check

/**
 * Magyx Free Shipping
 *
 * Waives shipping whenever the cart contains the shop's shared $0 "Free
 * Shipping" marker variant — silently included as a gift component by any
 * bundle with free shipping enabled (see ensureFreeShippingMarkerVariant in
 * app/models/shopify-sync.server.ts). The marker's mere presence is enough;
 * there's no need to know which bundle it came from.
 */

const NO_CHANGES = { operations: [] };

export function cartDeliveryOptionsDiscountsGenerateRun(input) {
  if (!input.discount.discountClasses.includes("SHIPPING")) return NO_CHANGES;

  const hasFreeShippingMarker = input.cart.lines.some(
    (line) => line.merchandise?.freeShippingMarker?.value === "true",
  );
  if (!hasFreeShippingMarker) return NO_CHANGES;

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
