import {
  BlockStack,
  InlineStack,
  Text,
  Button,
  Checkbox,
  Box,
  Divider,
  Thumbnail,
  Badge,
  TextField,
} from "@shopify/polaris";
import { DeleteIcon, ImageIcon, PlusIcon } from "@shopify/polaris-icons";
import type { ItemState } from "./types";

// FIXED and SLOT_BUILDER: free gifts always included at no extra cost.
export function GiftsSection({
  giftItems,
  setActiveItems,
  openResourcePicker,
  freeShipping,
  onFreeShippingChange,
  progressive = false,
  inheritedGiftItems = [],
  inheritedFreeShipping = false,
}: {
  giftItems: ItemState[];
  setActiveItems: (updater: (current: ItemState[]) => ItemState[]) => void;
  openResourcePicker: (isGiftFlag: boolean) => void;
  freeShipping: boolean;
  onFreeShippingChange: (checked: boolean) => void;
  // SLOT_BUILDER only: gifts unlock progressively across packages — this
  // package's gifts ship with every later package too.
  progressive?: boolean;
  // SLOT_BUILDER only: what earlier packages already contribute to this one.
  // Shown read-only — they're edited on the package that introduced them, so
  // making them editable here would beg the question of which package a change
  // applies to.
  inheritedGiftItems?: ItemState[];
  inheritedFreeShipping?: boolean;
}) {
  // An earlier package already granted it, so this package has it either way —
  // reflect that rather than showing an unchecked box for a perk the customer
  // does get. Still togglable when nothing upstream provides it.
  const freeShippingChecked = freeShipping || inheritedFreeShipping;
  return (
    <BlockStack gap="400">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="h2" variant="headingMd">
          Free gifts
        </Text>
        <Button icon={PlusIcon} onClick={() => openResourcePicker(true)}>
          Add free gift
        </Button>
      </InlineStack>
      <Text as="p" variant="bodySm" tone="subdued">
        {progressive
          ? "Optional. Gifts unlock progressively: this package's gifts also ship free with every bigger package. On the storefront, customers see them as soon as they pick this package — gifts from bigger packages show locked, nudging them to upgrade."
          : "Optional. These products are always included at no extra cost alongside the bundle — they don't affect its price."}
      </Text>
      <Checkbox
        label="Include free shipping as a gift"
        checked={freeShippingChecked}
        disabled={inheritedFreeShipping}
        onChange={onFreeShippingChange}
        helpText={
          inheritedFreeShipping
            ? "Already on from an earlier package — free shipping carries forward to every bigger package. Turn it off there to remove it here."
            : "Waives shipping at checkout when a customer buys this bundle."
        }
      />
      {giftItems.length === 0 ? (
        <Box padding="400">
          <Text as="p" tone="subdued" alignment="center">
            No free gifts added.
          </Text>
        </Box>
      ) : (
        <BlockStack gap="300">
          {giftItems.map((item, index) => (
            <Box key={item.variantId ?? item.productId}>
              {index > 0 && <Box paddingBlockEnd="300"><Divider /></Box>}
              <InlineStack
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
                  <BlockStack gap="050" inlineAlign="start">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" variant="bodyMd" fontWeight="medium">
                        {item.productTitle}
                      </Text>
                      {item.missing && (
                        <Badge tone="critical">Deleted from store</Badge>
                      )}
                    </InlineStack>
                    <Badge tone="success">Free gift</Badge>
                  </BlockStack>
                </InlineStack>
                <InlineStack gap="200" blockAlign="center" wrap={false}>
                  <div style={{ width: 90 }}>
                    <TextField
                      label="Qty"
                      labelHidden
                      type="number"
                      min={1}
                      value={String(item.quantity)}
                      onChange={(value) =>
                        setActiveItems((current) =>
                          current.map((c) =>
                            (c.variantId ?? c.productId) ===
                            (item.variantId ?? item.productId)
                              ? { ...c, quantity: Math.max(1, parseInt(value, 10) || 1) }
                              : c,
                          ),
                        )
                      }
                      autoComplete="off"
                      prefix="×"
                    />
                  </div>
                  <Button
                    icon={DeleteIcon}
                    variant="tertiary"
                    tone="critical"
                    accessibilityLabel={`Remove ${item.productTitle}`}
                    onClick={() =>
                      setActiveItems((current) =>
                        current.filter(
                          (c) =>
                            (c.variantId ?? c.productId) !==
                            (item.variantId ?? item.productId),
                        ),
                      )
                    }
                  />
                </InlineStack>
              </InlineStack>
            </Box>
          ))}
        </BlockStack>
      )}
      {inheritedGiftItems.length > 0 && (
        <>
          <Divider />
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">
              Also included from earlier packages
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              These ship with this package too. Edit them on the package that
              added them.
            </Text>
            <BlockStack gap="200">
              {inheritedGiftItems.map((item) => (
                <InlineStack
                  key={item.variantId ?? item.productId}
                  gap="300"
                  blockAlign="center"
                  wrap={false}
                >
                  <Thumbnail
                    source={item.productImageUrl || ImageIcon}
                    alt={item.productTitle}
                    size="small"
                  />
                  <Text as="span" variant="bodyMd" tone="subdued">
                    {item.productTitle}
                  </Text>
                  {item.quantity > 1 && (
                    <Text as="span" variant="bodySm" tone="subdued">
                      ×{item.quantity}
                    </Text>
                  )}
                </InlineStack>
              ))}
            </BlockStack>
          </BlockStack>
        </>
      )}
    </BlockStack>
  );
}
