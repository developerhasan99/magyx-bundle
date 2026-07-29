import { BlockStack, Text, ChoiceList, TextField, Box, InlineStack, Divider } from "@shopify/polaris";
import { currencySymbol, formatMoney } from "../../utils/money";
import type { ItemState } from "./types";

// Shared pricing controls (fixed price / percent off / amount off) plus the
// FIXED-only compare-at math box. SLOT_BUILDER is fixed-price only (a
// customer's slot picks aren't known until checkout, so there's no
// trustworthy "combined price" to discount off of) — it skips the pricing
// type choice entirely.
export function PricingSection({
  type,
  shopCurrency,
  activePricingType,
  activePricingValue,
  onPricingTypeChange,
  onPricingValueChange,
  pricingValueError,
  paidItems,
  combinedPrice,
  computedBundlePrice,
  savings,
  hasMissingPrices,
}: {
  type: string;
  shopCurrency: string;
  activePricingType: string;
  activePricingValue: string;
  onPricingTypeChange: (value: string) => void;
  onPricingValueChange: (value: string) => void;
  pricingValueError: string | undefined;
  paidItems: ItemState[];
  combinedPrice: number;
  computedBundlePrice: number;
  savings: number;
  hasMissingPrices: boolean;
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
      <div style={{ maxWidth: 200 }}>
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
        />
      </div>
      {(type === "FIXED" || type === "SLOT_BUILDER") && paidItems.length > 0 && (
        <Box background="bg-surface-secondary" borderRadius="200" padding="300">
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="span" variant="bodyMd" tone="subdued">
                Original price (compare-at)
              </Text>
              <Text
                as="span"
                variant="bodyMd"
                tone="subdued"
                textDecorationLine={
                  savings > 0 ? "line-through" : undefined
                }
              >
                {formatMoney(combinedPrice, shopCurrency)}
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
                {type === "SLOT_BUILDER"
                  ? `The original ${formatMoney(combinedPrice, shopCurrency)} price — the pool's average item price times the slot count — is set as the compare-at (strikethrough) price on the bundle product.`
                  : `The original ${formatMoney(combinedPrice, shopCurrency)} combined price is set as the compare-at (strikethrough) price on the bundle product.`}
              </Text>
            ) : (
              <Text as="p" variant="bodySm" tone="caution">
                {type === "SLOT_BUILDER"
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
      )}
    </BlockStack>
  );
}
