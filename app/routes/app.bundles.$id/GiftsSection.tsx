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

// FIXED bundles only: free gifts always included at no extra cost.
export function GiftsSection({
  giftItems,
  setActiveItems,
  openResourcePicker,
  freeShipping,
  onFreeShippingChange,
}: {
  giftItems: ItemState[];
  setActiveItems: (updater: (current: ItemState[]) => ItemState[]) => void;
  openResourcePicker: (isGiftFlag: boolean) => void;
  freeShipping: boolean;
  onFreeShippingChange: (checked: boolean) => void;
}) {
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
        Optional. These products are always included at no extra cost
        alongside the bundle — they don&apos;t affect its price.
      </Text>
      <Checkbox
        label="Include free shipping as a gift"
        checked={freeShipping}
        onChange={onFreeShippingChange}
        helpText="Waives shipping at checkout when a customer buys this bundle."
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
    </BlockStack>
  );
}
