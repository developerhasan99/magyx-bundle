// @ts-check

/**
 * Magyx Bundle Cart Transform
 *
 * 1. FIXED bundles — a cart line whose variant carries the
 *    `$app:magyx-bundle/components` metafield is expanded into its component
 *    variants, priced so the total equals the bundle price.
 * 2. MIX & MATCH bundles — cart lines tagged with the `_magyx_bundle_id`
 *    attribute are grouped per bundle; when the group reaches a discount
 *    tier from the shop config metafield, each line is repriced.
 * 3. QUANTITY BREAKS bundles — cart lines are matched to whichever bundle's
 *    scope covers their product (ALL / an explicit product list / a
 *    resolved collection product list, no attribute needed) and grouped per
 *    product; when a product's total quantity reaches a tier, its lines are
 *    repriced per that tier's own pricing type.
 * 4. SLOT BUILDER bundles — a cart line tagged with the `_magyx_slot_bundle_id`
 *    attribute carries the customer's slot picks in `_magyx_slot_selection`
 *    (JSON `[{productId, variantId, quantity}]`). Every pick is checked
 *    against that bundle's own resolved pool (`slotPoolProductIds`) and the
 *    total must equal its slot count — untrusted client data never
 *    determines price or which products ship, only *which* pool members
 *    were chosen. The line's own price (merchant-set, immutable per publish)
 *    is split evenly across the picks and expanded exactly like a FIXED
 *    bundle, plus whichever package's free gifts/free-shipping apply.
 */

const NO_CHANGES = { operations: [] };

export function run(input) {
  const operations = [];

  for (const line of input.cart.lines) {
    const componentsValue = line.merchandise?.components?.value;
    if (!componentsValue) continue;
    const expandOp = buildExpandOperation(line, componentsValue);
    if (expandOp) operations.push({ expand: expandOp });
  }

  const config = parseJson(input.shop?.config?.value);
  if (config?.bundles?.length) {
    operations.push(...buildMixMatchOperations(input.cart.lines, config.bundles));
    operations.push(...buildQuantityBreakOperations(input.cart.lines, config.bundles));

    for (const line of input.cart.lines) {
      const expandOp = buildSlotBuilderExpandOperation(line, config.bundles);
      if (expandOp) operations.push({ expand: expandOp });
    }
  }

  return operations.length ? { operations } : NO_CHANGES;
}

function buildExpandOperation(line, componentsValue) {
  const data = parseJson(componentsValue);
  const components = data?.components;
  if (!Array.isArray(components) || components.length === 0) return null;

  // Bundles with free shipping enabled stamp this attribute onto their first
  // expanded line so the magyx-free-shipping Discount Function can detect it
  // — a Discount Function only ever sees the expanded lines, not the parent
  // bundle line, so there's no other way to carry this through.
  const freeShippingAttributes = data?.freeShipping
    ? [{ key: "_magyx_free_shipping", value: "true" }]
    : [];

  const priced = components.filter((c) => !c.isGift);
  const gifts = components.filter((c) => c.isGift);

  const combined = priced.reduce(
    (sum, c) => sum + (c.price ?? 0) * (c.quantity ?? 1),
    0,
  );
  if (combined <= 0) return null;

  // The parent line's per-unit cost is the bundle price the merchant set
  const bundlePrice = parseFloat(line.cost.amountPerQuantity.amount);

  // Distribute the bundle price across paid components proportionally to
  // their catalog prices; the last paid component absorbs rounding
  // remainders. Gift components are priced separately below, always at
  // exactly $0.00 — they never take part in this allocation.
  const expandedCartItems = [];
  let allocated = 0;
  for (let i = 0; i < priced.length; i++) {
    const component = priced[i];
    const quantity = component.quantity ?? 1;
    const share = ((component.price ?? 0) * quantity) / combined;
    let perUnit;
    if (i === priced.length - 1) {
      perUnit = (bundlePrice - allocated) / quantity;
    } else {
      perUnit = (bundlePrice * share) / quantity;
    }
    perUnit = Math.round(perUnit * 100) / 100;
    allocated += perUnit * quantity;
    expandedCartItems.push({
      merchandiseId: component.variantId,
      quantity,
      price: {
        adjustment: {
          fixedPricePerUnit: { amount: perUnit.toFixed(2) },
        },
      },
      attributes: i === 0 ? freeShippingAttributes : undefined,
    });
  }

  for (const gift of gifts) {
    expandedCartItems.push({
      merchandiseId: gift.variantId,
      quantity: gift.quantity ?? 1,
      price: {
        adjustment: {
          fixedPricePerUnit: { amount: "0.00" },
        },
      },
      // Visible cart/checkout line item property so gift components are
      // clearly called out to the customer instead of just showing $0.00.
      attributes: [{ key: "Free Gift", value: "Yes" }],
    });
  }

  return { cartLineId: line.id, expandedCartItems };
}

// SLOT_BUILDER: the customer's picks aren't known until add-to-cart time, so
// (unlike FIXED) they can't be baked into a variant metafield at publish
// time — they arrive as cart line properties instead. Nothing about price or
// product eligibility is trusted from that client data: the line's own price
// is always the merchant-set total, and every pick must resolve to a member
// of *that package's own* pool (`slotPoolProductIds`, resolved server-side at
// save time — each package/bottle-size has an independent pool and slot
// count) with the total matching that package's slot count exactly. Any
// mismatch leaves the line un-expanded rather than guessing — a forged
// property should never be able to swap in an out-of-pool product or a
// partial pick.
function buildSlotBuilderExpandOperation(line, bundles) {
  const bundleId = line.slotBundleId?.value;
  const selectionRaw = line.slotSelection?.value;
  if (!bundleId || !selectionRaw) return null;

  const bundle = bundles.find((b) => b.id === bundleId && b.type === "SLOT_BUILDER");
  if (!bundle) return null;

  const pkg = (bundle.packages ?? []).find((p) => p.shopifyVariantId === line.merchandise.id);
  if (!pkg) return null;

  const selection = parseJson(selectionRaw);
  if (!Array.isArray(selection) || selection.length === 0) return null;

  const slotCount = pkg.slotCount ?? 0;
  const poolProductIds = new Set(pkg.slotPoolProductIds ?? []);

  let totalQuantity = 0;
  for (const item of selection) {
    if (!item?.variantId || !item?.productId || !poolProductIds.has(item.productId)) return null;
    const quantity = item.quantity ?? 1;
    if (quantity < 1) return null;
    totalQuantity += quantity;
  }
  if (slotCount <= 0 || totalQuantity !== slotCount) return null;

  // Bundle Builder is fixed-price only, and there's no trustworthy per-pick
  // catalog price to weight by (it would have to come from the client) — an
  // even split across the filled slots needs nothing but the line's own
  // already-trusted price.
  const bundlePrice = parseFloat(line.cost.amountPerQuantity.amount);
  const perUnit = Math.round((bundlePrice / slotCount) * 100) / 100;

  const freeShippingAttributes = pkg?.freeShipping
    ? [{ key: "_magyx_free_shipping", value: "true" }]
    : [];

  const expandedCartItems = [];
  let allocated = 0;
  selection.forEach((item, index) => {
    const quantity = item.quantity ?? 1;
    let unitPrice;
    if (index === selection.length - 1) {
      unitPrice = (bundlePrice - allocated) / quantity;
    } else {
      unitPrice = perUnit;
    }
    unitPrice = Math.round(unitPrice * 100) / 100;
    allocated += unitPrice * quantity;
    expandedCartItems.push({
      merchandiseId: item.variantId,
      quantity,
      price: { adjustment: { fixedPricePerUnit: { amount: unitPrice.toFixed(2) } } },
      attributes: index === 0 ? freeShippingAttributes : undefined,
    });
  });

  for (const gift of Array.isArray(pkg?.gifts) ? pkg.gifts : []) {
    expandedCartItems.push({
      merchandiseId: gift.variantId,
      quantity: gift.quantity ?? 1,
      price: { adjustment: { fixedPricePerUnit: { amount: "0.00" } } },
      attributes: [{ key: "Free Gift", value: "Yes" }],
    });
  }

  return { cartLineId: line.id, expandedCartItems };
}

function buildMixMatchOperations(lines, bundles) {
  const bundlesById = new Map(
    bundles.filter((b) => b.type === "MIX_MATCH").map((b) => [b.id, b]),
  );

  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const line of lines) {
    const bundleId = line.bundleId?.value;
    if (!bundleId || !bundlesById.has(bundleId)) continue;
    const group = groups.get(bundleId) ?? [];
    group.push(line);
    groups.set(bundleId, group);
  }

  const operations = [];
  for (const [bundleId, group] of groups) {
    const bundle = bundlesById.get(bundleId);
    const rule = bundle.rule;
    if (!rule) continue;

    const eligibleProducts = new Set(bundle.items.map((i) => i.productId));
    const eligibleLines = group.filter((line) =>
      eligibleProducts.has(line.merchandise?.product?.id),
    );

    const totalQuantity = eligibleLines.reduce((sum, l) => sum + l.quantity, 0);
    if (totalQuantity < (rule.minItems ?? 1)) continue;
    if (rule.maxItems && totalQuantity > rule.maxItems) continue;

    const tiers = Array.isArray(rule.discountTiers) ? rule.discountTiers : [];
    const tier = tiers
      .filter((t) => totalQuantity >= t.quantity)
      .sort((a, b) => b.quantity - a.quantity)[0];
    if (!tier || tier.discount <= 0) continue;

    for (const line of eligibleLines) {
      const original = parseFloat(line.cost.amountPerQuantity.amount);
      const discounted =
        Math.round(original * (1 - tier.discount / 100) * 100) / 100;
      operations.push({
        update: {
          cartLineId: line.id,
          price: {
            adjustment: {
              fixedPricePerUnit: { amount: discounted.toFixed(2) },
            },
          },
        },
      });
    }
  }
  return operations;
}

function buildQuantityBreakOperations(lines, bundles) {
  const qbBundles = bundles.filter((b) => b.type === "QUANTITY_BREAKS");
  if (qbBundles.length === 0) return [];

  // PRODUCTS/COLLECTIONS scope bundles are keyed by their resolved product
  // id list (COLLECTIONS is already flattened into this list at sync time,
  // since checkout can't check collection membership dynamically); ALL scope
  // has no list and matches any product not already claimed by a more
  // specific bundle.
  const allScopeBundles = qbBundles.filter((b) => b.quantityBreakScope === "ALL");
  const bundleByProductId = new Map();
  for (const bundle of qbBundles) {
    if (bundle.quantityBreakScope === "ALL") continue;
    for (const productId of bundle.quantityBreakProductIds ?? []) {
      if (!bundleByProductId.has(productId)) bundleByProductId.set(productId, bundle);
    }
  }

  function bundleForProduct(productId) {
    return bundleByProductId.get(productId) ?? allScopeBundles[0];
  }

  // Grouped by (bundle, productId): each eligible product qualifies for its
  // pack-size tiers independently, purely off its own quantity in cart — not
  // combined across different products, even ones the same bundle applies to.
  /** @type {Map<string, { bundle: any, lines: any[] }>} */
  const groups = new Map();
  for (const line of lines) {
    const productId = line.merchandise?.product?.id;
    if (!productId) continue;
    const bundle = bundleForProduct(productId);
    if (!bundle) continue;
    const key = bundle.id + ":" + productId;
    const group = groups.get(key) ?? { bundle, lines: [] };
    group.lines.push(line);
    groups.set(key, group);
  }

  const operations = [];
  for (const { bundle, lines: group } of groups.values()) {
    const tiers = Array.isArray(bundle.tiers) ? bundle.tiers : [];
    const totalQuantity = group.reduce((sum, l) => sum + l.quantity, 0);
    const tier = tiers
      .filter((t) => totalQuantity >= t.quantity)
      .sort((a, b) => b.quantity - a.quantity)[0];
    if (!tier) continue;

    const gifts = Array.isArray(tier.giftVariantIds) ? tier.giftVariantIds : [];
    // Gifts only ever ride along on one line in the group — attaching them
    // to every line would duplicate the free product for shoppers who split
    // their quantity across variants of the same product.
    let giftsAttached = false;

    for (const line of group) {
      const original = parseFloat(line.cost.amountPerQuantity.amount);
      const discounted = tierUnitPrice(original, tier);
      const needsPriceChange = discounted != null && discounted < original;

      if (gifts.length > 0 && !giftsAttached) {
        giftsAttached = true;
        operations.push({
          expand: {
            cartLineId: line.id,
            expandedCartItems: [
              {
                merchandiseId: line.merchandise.id,
                quantity: line.quantity,
                price: {
                  adjustment: {
                    fixedPricePerUnit: {
                      amount: (needsPriceChange ? discounted : original).toFixed(2),
                    },
                  },
                },
              },
              ...gifts.map((gift) => ({
                merchandiseId: gift.variantId,
                quantity: gift.quantity ?? 1,
                price: { adjustment: { fixedPricePerUnit: { amount: "0.00" } } },
                attributes: [{ key: "Free Gift", value: "Yes" }],
              })),
            ],
          },
        });
        continue;
      }

      if (needsPriceChange) {
        operations.push({
          update: {
            cartLineId: line.id,
            price: {
              adjustment: {
                fixedPricePerUnit: { amount: discounted.toFixed(2) },
              },
            },
          },
        });
      }
    }
  }
  return operations;
}

function tierUnitPrice(original, tier) {
  if (tier.pricingType === "FIXED_PRICE") {
    return Math.round(tier.pricingValue * 100) / 100;
  }
  if (tier.pricingType === "AMOUNT_OFF") {
    return Math.max(0, Math.round((original - tier.pricingValue) * 100) / 100);
  }
  // PERCENT_OFF
  return Math.round(original * (1 - tier.pricingValue / 100) * 100) / 100;
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
