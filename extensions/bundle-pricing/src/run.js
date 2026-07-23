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
  }

  return operations.length ? { operations } : NO_CHANGES;
}

function buildExpandOperation(line, componentsValue) {
  const data = parseJson(componentsValue);
  const components = data?.components;
  if (!Array.isArray(components) || components.length === 0) return null;

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

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
