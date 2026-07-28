import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Divider,
  Thumbnail,
  Box,
  Select,
  TextField,
  Button,
} from "@shopify/polaris";
import { ImageIcon, EditIcon } from "@shopify/polaris-icons";
import type { CollectionState, ItemState } from "./types";

interface ShopifyProductPreview {
  title: string;
  status: string;
  imageUrl: string | null;
  price: string | null;
  previewUrl: string | null;
}

// The right-column "Preview" + "Publishing" cards.
export function PreviewSidebar({
  type,
  title,
  description,
  status,
  setStatus,
  showAllProductsNotice,
  showCollectionPool,
  collections,
  activeItems,
  itemCount,
  previewSummary,
  minItems,
  maxItems,
  slotCount,
  isNew,
  bundleId,
  shopifyProductId,
  shopifyProduct,
  editBundleProduct,
  onCopyBundleId,
}: {
  type: string;
  title: string;
  description: string;
  status: string;
  setStatus: (value: string) => void;
  showAllProductsNotice: boolean;
  showCollectionPool: boolean;
  collections: CollectionState[];
  activeItems: ItemState[];
  // Eligible-product count for MIX_MATCH/SLOT_BUILDER/QUANTITY_BREAKS summary
  // text — distinct from activeItems, which is FIXED's active package items.
  itemCount: number;
  previewSummary: string;
  minItems: string;
  maxItems: string;
  slotCount: string;
  isNew: boolean;
  bundleId: string | undefined;
  shopifyProductId: string | null | undefined;
  shopifyProduct: ShopifyProductPreview | null;
  editBundleProduct: () => void;
  onCopyBundleId: () => void;
}) {
  return (
    <>
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">
              Preview
            </Text>
            <Badge
              tone={
                type === "FIXED"
                  ? "info"
                  : type === "SLOT_BUILDER"
                    ? "attention"
                    : type === "QUANTITY_BREAKS"
                      ? "success"
                      : "magic"
              }
            >
              {type === "FIXED"
                ? "Fixed"
                : type === "SLOT_BUILDER"
                  ? "Bundle builder"
                  : type === "QUANTITY_BREAKS"
                    ? "Quantity breaks"
                    : "Mix & match"}
            </Badge>
          </InlineStack>
          <Divider />
          <Text as="p" variant="headingSm">
            {title || "Untitled bundle"}
          </Text>
          {description && (
            <Text as="p" variant="bodySm" tone="subdued">
              {description}
            </Text>
          )}
          <BlockStack gap="200">
            {showAllProductsNotice ? (
              <Text as="span" variant="bodySm" tone="subdued">
                All products
              </Text>
            ) : showCollectionPool ? (
              <>
                {collections.map((collection) => (
                  <InlineStack
                    key={collection.id}
                    gap="200"
                    blockAlign="center"
                    wrap={false}
                  >
                    <Thumbnail
                      source={collection.imageUrl || ImageIcon}
                      alt={collection.title}
                      size="extraSmall"
                    />
                    <Text as="span" variant="bodySm" truncate>
                      {collection.title}
                    </Text>
                  </InlineStack>
                ))}
                {collections.length === 0 && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    No collections yet
                  </Text>
                )}
              </>
            ) : (
              <>
                {activeItems.slice(0, 5).map((item) => (
                  <InlineStack key={item.productId} gap="200" blockAlign="center" wrap={false}>
                    <Thumbnail
                      source={item.productImageUrl || ImageIcon}
                      alt={item.productTitle}
                      size="extraSmall"
                    />
                    <Text as="span" variant="bodySm" truncate>
                      {type === "FIXED" ? `${item.quantity} × ` : ""}
                      {item.productTitle}
                    </Text>
                  </InlineStack>
                ))}
                {activeItems.length > 5 && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    +{activeItems.length - 5} more
                  </Text>
                )}
                {activeItems.length === 0 && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    No products yet
                  </Text>
                )}
              </>
            )}
          </BlockStack>
          <Divider />
          <Text as="p" variant="bodySm" fontWeight="semibold">
            {previewSummary}
          </Text>
          {type === "MIX_MATCH" && (
            <Text as="p" variant="bodySm" tone="subdued">
              Customers pick {minItems || "?"}
              {maxItems ? `–${maxItems}` : "+"} items from{" "}
              {showCollectionPool
                ? `${collections.length} collection${collections.length === 1 ? "" : "s"}`
                : `${itemCount} eligible product${itemCount === 1 ? "" : "s"}`}
              .
            </Text>
          )}
          {type === "SLOT_BUILDER" && (
            <Text as="p" variant="bodySm" tone="subdued">
              Customers fill {slotCount || "?"} slots from{" "}
              {showCollectionPool
                ? `${collections.length} collection${collections.length === 1 ? "" : "s"}`
                : `${itemCount} product${itemCount === 1 ? "" : "s"} in the pool`}
              .
            </Text>
          )}
          {type === "QUANTITY_BREAKS" && (
            <Text as="p" variant="bodySm" tone="subdued">
              Applies across every variant of{" "}
              {showAllProductsNotice
                ? "every product in your store"
                : showCollectionPool
                  ? `${collections.length} collection${collections.length === 1 ? "" : "s"}`
                  : `${itemCount} product${itemCount === 1 ? "" : "s"}`}
              .
            </Text>
          )}
        </BlockStack>
      </Card>
      <Box paddingBlockStart="400">
        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">
              Publishing
            </Text>
            <Select
              label="Status"
              options={[
                { label: "Draft", value: "DRAFT" },
                { label: "Active", value: "ACTIVE" },
              ]}
              value={status}
              onChange={setStatus}
            />
            <Text as="p" variant="bodySm" tone="subdued">
              {type === "FIXED"
                ? "When set to Active, Magyx Bundle creates a bundle product in your store. It's expanded into its components at checkout, so inventory stays accurate."
                : type === "SLOT_BUILDER"
                  ? "When set to Active, Magyx Bundle creates a bundle product in your store. Customers fill each slot from your product pool on its product page, and it's expanded into their picks at checkout, so inventory stays accurate."
                  : type === "QUANTITY_BREAKS"
                    ? "When set to Active, the quantity breaks widget shows automatically on this product's page once you've added the theme block — no separate product is created, and discounts apply automatically at checkout."
                    : "When set to Active, the mix & match builder becomes available as an app block in your theme editor, and discounts apply automatically at checkout."}
            </Text>
            {!isNew && (type === "FIXED" || type === "SLOT_BUILDER") && shopifyProductId && (
              shopifyProduct ? (
                <Box
                  borderColor="border"
                  borderWidth="025"
                  borderRadius="200"
                  padding="300"
                >
                  <InlineStack
                    gap="300"
                    blockAlign="center"
                    align="space-between"
                    wrap={false}
                  >
                    <InlineStack gap="300" blockAlign="center" wrap={false}>
                      <Thumbnail
                        source={shopifyProduct.imageUrl || ImageIcon}
                        alt={shopifyProduct.title}
                        size="small"
                      />
                      <BlockStack gap="100">
                        <Text as="span" variant="bodyMd" fontWeight="medium">
                          {shopifyProduct.title}
                        </Text>
                        <InlineStack gap="200" blockAlign="center">
                          <Badge
                            size="small"
                            tone={
                              shopifyProduct.status === "ACTIVE"
                                ? "success"
                                : shopifyProduct.status === "DRAFT"
                                  ? "info"
                                  : undefined
                            }
                          >
                            {shopifyProduct.status.charAt(0) +
                              shopifyProduct.status.slice(1).toLowerCase()}
                          </Badge>
                          {shopifyProduct.price && (
                            <Text as="span" variant="bodySm" tone="subdued">
                              ${shopifyProduct.price}
                            </Text>
                          )}
                        </InlineStack>
                      </BlockStack>
                    </InlineStack>
                    <Button
                      icon={EditIcon}
                      variant="tertiary"
                      accessibilityLabel="Edit bundle product"
                      onClick={editBundleProduct}
                    />
                  </InlineStack>
                </Box>
              ) : (
                <div>
                  <Button variant="plain" onClick={editBundleProduct}>
                    View bundle product in admin
                  </Button>
                </div>
              )
            )}
            {!isNew && type === "MIX_MATCH" && (
              <TextField
                label="Bundle ID"
                value={bundleId ?? ""}
                readOnly
                autoComplete="off"
                helpText="Paste this into the Mix & Match Bundle block in your theme editor."
                connectedRight={<Button onClick={onCopyBundleId}>Copy</Button>}
              />
            )}
          </BlockStack>
        </Card>
      </Box>
    </>
  );
}
