import {
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  Badge,
  InlineGrid,
  TextField,
  Select,
  Divider,
  Thumbnail,
} from "@shopify/polaris";
import { DeleteIcon, ImageIcon, PlusIcon } from "@shopify/polaris-icons";
import { PackageTab } from "./PackageTab";
import { BADGE_TONE_OPTIONS, type QbTierState } from "./types";

// QUANTITY_BREAKS only: pack-size tabs + detail fields + per-tier free gifts
// for whichever tab is active.
export function QuantityBreaksTiersSection({
  qbTiers,
  activeQbTierIndex,
  setActiveQbTierIndex,
  addQbTier,
  updateQbTier,
  removeQbTier,
  setQbTierDefault,
  openQbTierGiftPicker,
  removeQbTierItem,
}: {
  qbTiers: QbTierState[];
  activeQbTierIndex: number;
  setActiveQbTierIndex: (index: number) => void;
  addQbTier: () => void;
  updateQbTier: (tempKey: string, patch: Partial<QbTierState>) => void;
  removeQbTier: (tempKey: string) => void;
  setQbTierDefault: (tempKey: string) => void;
  openQbTierGiftPicker: (tempKey: string) => void;
  removeQbTierItem: (tempKey: string, key: string) => void;
}) {
  const activeQbTier = qbTiers[activeQbTierIndex];

  return (
    <BlockStack gap="400">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="h2" variant="headingMd">
          Pack sizes
        </Text>
        <Button icon={PlusIcon} onClick={addQbTier}>
          Add pack size
        </Button>
      </InlineStack>
      {!activeQbTier ? (
        <Box padding="400">
          <Text as="p" tone="subdued" alignment="center">
            Add the pack sizes customers can choose from.
          </Text>
        </Box>
      ) : (
        <BlockStack gap="400">
          {qbTiers.length > 1 && (
            <InlineStack gap="200" wrap>
              {qbTiers.map((tier, index) => (
                <PackageTab
                  key={tier.tempKey}
                  label={tier.label || `Pack ${index + 1}`}
                  badgeText={tier.badgeText}
                  badgeTone={tier.badgeTone}
                  selected={index === activeQbTierIndex}
                  onSelect={() => setActiveQbTierIndex(index)}
                />
              ))}
            </InlineStack>
          )}

          <InlineStack align="space-between" blockAlign="center">
            {activeQbTier.isDefault ? (
              <Badge tone="success">Default selection</Badge>
            ) : (
              <Button variant="plain" onClick={() => setQbTierDefault(activeQbTier.tempKey)}>
                Set as default selection
              </Button>
            )}
            <Button
              icon={DeleteIcon}
              variant="tertiary"
              tone="critical"
              disabled={qbTiers.length <= 1}
              onClick={() => removeQbTier(activeQbTier.tempKey)}
            >
              Remove pack size
            </Button>
          </InlineStack>

          <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
            <TextField
              label="Quantity"
              type="number"
              min={1}
              value={activeQbTier.quantity}
              onChange={(value) => updateQbTier(activeQbTier.tempKey, { quantity: value })}
              autoComplete="off"
            />
            <TextField
              label="Label"
              value={activeQbTier.label}
              onChange={(value) => updateQbTier(activeQbTier.tempKey, { label: value })}
              autoComplete="off"
              placeholder="e.g. 2 pack"
            />
          </InlineGrid>

          <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
            <Select
              label="Pricing"
              options={[
                { label: "Percent off", value: "PERCENT_OFF" },
                { label: "Amount off", value: "AMOUNT_OFF" },
                { label: "Fixed price per unit", value: "FIXED_PRICE" },
              ]}
              value={activeQbTier.pricingType}
              onChange={(value) => updateQbTier(activeQbTier.tempKey, { pricingType: value })}
            />
            <TextField
              label={
                activeQbTier.pricingType === "PERCENT_OFF"
                  ? "Discount"
                  : activeQbTier.pricingType === "AMOUNT_OFF"
                    ? "Amount off"
                    : "Price per unit"
              }
              type="number"
              min={0}
              max={activeQbTier.pricingType === "PERCENT_OFF" ? 100 : undefined}
              value={activeQbTier.pricingValue}
              onChange={(value) => updateQbTier(activeQbTier.tempKey, { pricingValue: value })}
              autoComplete="off"
              prefix={activeQbTier.pricingType === "PERCENT_OFF" ? undefined : "$"}
              suffix={activeQbTier.pricingType === "PERCENT_OFF" ? "%" : undefined}
            />
          </InlineGrid>

          <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
            <Select
              label="Badge"
              options={BADGE_TONE_OPTIONS}
              value={activeQbTier.badgeTone}
              onChange={(value) => updateQbTier(activeQbTier.tempKey, { badgeTone: value })}
            />
            <TextField
              label="Badge text"
              value={activeQbTier.badgeText}
              onChange={(value) => updateQbTier(activeQbTier.tempKey, { badgeText: value })}
              autoComplete="off"
              placeholder="e.g. Save 20%"
            />
          </InlineGrid>

          <Divider />

          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingXs">
                Free gifts
              </Text>
              <Button
                variant="plain"
                icon={PlusIcon}
                onClick={() => openQbTierGiftPicker(activeQbTier.tempKey)}
              >
                Add free gift
              </Button>
            </InlineStack>
            {activeQbTier.items.length === 0 ? (
              <Text as="p" variant="bodySm" tone="subdued">
                No free gifts for this pack size.
              </Text>
            ) : (
              <BlockStack gap="200">
                {activeQbTier.items.map((item) => (
                  <InlineStack
                    key={item.variantId ?? item.productId}
                    gap="300"
                    blockAlign="center"
                    align="space-between"
                    wrap={false}
                  >
                    <InlineStack gap="300" blockAlign="center" wrap={false}>
                      <Thumbnail
                        source={item.productImageUrl || ImageIcon}
                        alt={item.productTitle}
                        size="small"
                      />
                      <BlockStack gap="050">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="bodyMd" fontWeight="medium">
                            {item.productTitle}
                          </Text>
                          {item.missing && (
                            <Badge tone="critical">Deleted from store</Badge>
                          )}
                        </InlineStack>
                        <Badge tone="success" size="small">
                          Free gift
                        </Badge>
                      </BlockStack>
                    </InlineStack>
                    <Button
                      icon={DeleteIcon}
                      variant="tertiary"
                      tone="critical"
                      accessibilityLabel={`Remove ${item.productTitle}`}
                      onClick={() =>
                        removeQbTierItem(activeQbTier.tempKey, item.variantId ?? item.productId)
                      }
                    />
                  </InlineStack>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </BlockStack>
      )}
    </BlockStack>
  );
}
