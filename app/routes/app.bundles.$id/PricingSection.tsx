import { BlockStack, Text, ChoiceList, TextField, Box, InlineStack, Divider } from "@shopify/polaris";
import { currencySymbol, formatMoney } from "../../utils/money";
import type { ItemState } from "./types";

// Shared pricing controls (fixed price / percent off / amount off). SLOT_
// BUILDER is fixed-price only (a customer's slot picks aren't known until
// checkout, so there's no trustworthy "combined price" to discount off of)
// — it skips the pricing type choice entirely. The compare-at math box lives
// in the separate PricingSummaryBox below, so a caller that lays this out
// in a multi-column grid (e.g. side-by-side with Slots) can still render
// that box full-width underneath instead of squeezed into one column.
export function PricingSection({
  type,
  shopCurrency,
  activePricingType,
  activePricingValue,
  onPricingTypeChange,
  onPricingValueChange,
  pricingValueError,
  compareAtPrice,
  onCompareAtPriceChange,
  computedCompareAtPrice,
}: {
  type: string;
  shopCurrency: string;
  activePricingType: string;
  activePricingValue: string;
  onPricingTypeChange: (value: string) => void;
  onPricingValueChange: (value: string) => void;
  pricingValueError: string | undefined;
  /** Merchant override; empty string means "use the computed one". */
  compareAtPrice: string;
  onCompareAtPriceChange: (value: string) => void;
  /** What the app works out on its own, shown as the placeholder. */
  computedCompareAtPrice: number;
}) {
  return (
    <BlockStack gap="400">
      <Text as="h2" variant="headingMd">
        Pricing
      </Text>
      {type !== "SLOT_BUILDER" && (
        <ChoiceList
          title="Pricing"
          titleHidden
          choices={[
            { label: "Fixed bundle price", value: "FIXED_PRICE" },
            { label: "Percentage off combined price", value: "PERCENT_OFF" },
            { label: "Amount off combined price", value: "AMOUNT_OFF" },
          ]}
          selected={[activePricingType]}
          onChange={(value) => onPricingTypeChange(value[0])}
        />
      )}
        <TextField
          label={
            type === "SLOT_BUILDER"
              ? "Bundle price"
              : activePricingType === "FIXED_PRICE"
              ? "Bundle price"
              : activePricingType === "PERCENT_OFF"
                ? "Discount"
                : "Amount off"
          }
          type="number"
          min={0}
          max={activePricingType === "PERCENT_OFF" ? 100 : undefined}
          value={activePricingValue}
          onChange={onPricingValueChange}
          autoComplete="off"
          prefix={activePricingType === "PERCENT_OFF" ? undefined : currencySymbol(shopCurrency)}
          suffix={activePricingType === "PERCENT_OFF" ? "%" : undefined}
          error={pricingValueError}
          helpText={
            type === "SLOT_BUILDER"
              ? "Customers pay this flat price no matter which products they pick."
              : undefined
          }
        />
        <TextField
          label="Compare-at price"
          type="number"
          min={0}
          value={compareAtPrice}
          onChange={onCompareAtPriceChange}
          autoComplete="off"
          prefix={currencySymbol(shopCurrency)}
          placeholder={
            computedCompareAtPrice > 0
              ? String(computedCompareAtPrice)
              : undefined
          }
          helpText={
            computedCompareAtPrice > 0
              ? `Optional. Leave empty to use ${formatMoney(computedCompareAtPrice, shopCurrency)}, worked out from the products themselves. Either way it's saved on the bundle's variant, so Shopify shows it in each customer's own currency.`
              : "Optional. Saved on the bundle's variant, so Shopify shows it in each customer's own currency."
          }
        />
    </BlockStack>
  );
}

// The compare-at math box (original/bundle/savings) — split out from
// PricingSection so a caller laying that out in a multi-column grid (e.g.
// side-by-side with Slots) can still render this full-width underneath
// instead of squeezed into one column.
export function PricingSummaryBox({
  type,
  shopCurrency,
  paidItems,
  combinedPrice,
  computedBundlePrice,
  savings,
  hasMissingPrices,
  effectiveCompareAtPrice,
  isCompareAtOverridden,
}: {
  type: string;
  shopCurrency: string;
  paidItems: ItemState[];
  combinedPrice: number;
  computedBundlePrice: number;
  savings: number;
  hasMissingPrices: boolean;
  /** Override when set, otherwise `combinedPrice` — what actually ships. */
  effectiveCompareAtPrice: number;
  isCompareAtOverridden: boolean;
}) {
  if (!(type === "FIXED" || type === "SLOT_BUILDER") || paidItems.length === 0) return null;
  return (
    <Box background="bg-surface-secondary" borderRadius="200" padding="300">
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="bodyMd" tone="subdued">
            {isCompareAtOverridden
              ? "Compare-at price (yours)"
              : "Original price (compare-at)"}
          </Text>
          <Text
            as="span"
            variant="bodyMd"
            tone="subdued"
            textDecorationLine={
              savings > 0 ? "line-through" : undefined
            }
          >
            {formatMoney(effectiveCompareAtPrice, shopCurrency)}
          </Text>
        </InlineStack>
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="bodyMd">
            Bundle price
          </Text>
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {formatMoney(computedBundlePrice, shopCurrency)}
          </Text>
        </InlineStack>
        <Divider />
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            Customer saves
          </Text>
          <Text
            as="span"
            variant="bodyMd"
            fontWeight="semibold"
            tone={savings > 0 ? "success" : "subdued"}
          >
            {formatMoney(Math.max(0, savings), shopCurrency)}
            {savings > 0 && combinedPrice > 0
              ? ` (${Math.round((savings / combinedPrice) * 100)}%)`
              : ""}
          </Text>
        </InlineStack>
        {savings > 0 ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {isCompareAtOverridden
              ? `${formatMoney(effectiveCompareAtPrice, shopCurrency)} is set as the compare-at (strikethrough) price on the bundle product, replacing the ${formatMoney(combinedPrice, shopCurrency)} worked out from the products.`
              : type === "SLOT_BUILDER"
                ? `The original ${formatMoney(combinedPrice, shopCurrency)} price — the pool's average item price times the slot count — is set as the compare-at (strikethrough) price on the bundle product.`
                : `The original ${formatMoney(combinedPrice, shopCurrency)} combined price is set as the compare-at (strikethrough) price on the bundle product.`}
          </Text>
        ) : (
          <Text as="p" variant="bodySm" tone="caution">
            {isCompareAtOverridden
              ? "Your compare-at price isn't above the bundle price, so no strikethrough will be shown to customers."
              : type === "SLOT_BUILDER"
                ? "The bundle price isn't below the pool's average price for this many slots, so no compare-at price will be shown to customers."
                : "The bundle price isn't below the combined price of its products, so no compare-at price will be shown to customers."}
          </Text>
        )}
        {hasMissingPrices && (
          <Text as="p" variant="bodySm" tone="caution">
            Some product prices couldn&apos;t be loaded, so
            these totals may be incomplete.
          </Text>
        )}
      </BlockStack>
    </Box>
  );
}
