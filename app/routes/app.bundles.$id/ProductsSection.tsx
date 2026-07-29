import {
  BlockStack,
  InlineStack,
  Text,
  Button,
  ChoiceList,
  Box,
  Divider,
  Thumbnail,
  Badge,
  TextField,
} from "@shopify/polaris";
import { DeleteIcon, ImageIcon, PlusIcon } from "@shopify/polaris-icons";
import { BundleTypeCard } from "../../components/BundleTypeCard";
import { formatMoney } from "../../utils/money";
import { QUANTITY_BREAK_SCOPE_OPTIONS, type CollectionState, type ItemState } from "./types";

// Shared product/collection pool block — reused by FIXED ("Products in
// bundle"), MIX_MATCH/SLOT_BUILDER ("Product pool"), and QUANTITY_BREAKS
// ("Applies to"), with per-type text/choices.
export function ProductsSection({
  type,
  shopCurrency,
  poolSource,
  setPoolSource,
  showCollectionPool,
  showAllProductsNotice,
  collections,
  setCollections,
  paidItems,
  setActiveItems,
  openResourcePicker,
  openCollectionPicker,
}: {
  type: string;
  shopCurrency: string;
  poolSource: string;
  setPoolSource: (value: string) => void;
  showCollectionPool: boolean;
  showAllProductsNotice: boolean;
  collections: CollectionState[];
  setCollections: (updater: (current: CollectionState[]) => CollectionState[]) => void;
  paidItems: ItemState[];
  setActiveItems: (updater: (current: ItemState[]) => ItemState[]) => void;
  openResourcePicker: (isGiftFlag: boolean) => void;
  openCollectionPicker: () => void;
}) {
  return (
    <BlockStack gap="400">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="h2" variant="headingMd">
          {type === "FIXED"
            ? "Products in bundle"
            : type === "QUANTITY_BREAKS"
              ? "Applies to"
              : "Product pool"}
        </Text>
        {!showAllProductsNotice &&
          (showCollectionPool ? (
            <Button icon={PlusIcon} onClick={openCollectionPicker}>
              Add collections
            </Button>
          ) : (
            <Button icon={PlusIcon} onClick={() => openResourcePicker(false)}>
              Add products
            </Button>
          ))}
      </InlineStack>
      {type === "QUANTITY_BREAKS" ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: "var(--p-space-300)",
          }}
        >
          {QUANTITY_BREAK_SCOPE_OPTIONS.map((option) => (
            <BundleTypeCard
              key={option.value}
              label={option.label}
              description={option.helpText}
              selected={poolSource === option.value}
              disabled={false}
              onSelect={() => setPoolSource(option.value)}
            />
          ))}
        </div>
      ) : (
        type !== "FIXED" && (
          <ChoiceList
            title="Customers pick from"
            choices={[
              {
                label: "Specific products",
                value: "PRODUCTS",
                helpText: "Hand-pick the products shown in the selection panel.",
              },
              {
                label: "Collections",
                value: "COLLECTIONS",
                helpText:
                  "Show every product from the chosen collections — stays up to date automatically.",
              },
            ]}
            selected={[poolSource]}
            onChange={(value) => setPoolSource(value[0])}
          />
        )
      )}
      {showAllProductsNotice ? (
        <Box padding="400">
          <Text as="p" tone="subdued" alignment="center">
            These pack sizes will be available on every product in your store.
          </Text>
        </Box>
      ) : showCollectionPool ? (
        collections.length === 0 ? (
          <Box padding="400">
            <Text as="p" tone="subdued" alignment="center">
              {type === "QUANTITY_BREAKS"
                ? "Select the collection(s) this applies to."
                : "Select the collections customers can pick products from."}
            </Text>
          </Box>
        ) : (
          <BlockStack gap="300">
            {collections.map((collection, index) => (
              <Box key={collection.id}>
                {index > 0 && <Box paddingBlockEnd="300"><Divider /></Box>}
                <InlineStack
                  gap="300"
                  blockAlign="center"
                  align="space-between"
                  wrap={false}
                >
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <Thumbnail
                      source={collection.imageUrl || ImageIcon}
                      alt={collection.title}
                      size="small"
                    />
                    <Text as="span" variant="bodyMd" fontWeight="medium">
                      {collection.title}
                    </Text>
                  </InlineStack>
                  <Button
                    icon={DeleteIcon}
                    variant="tertiary"
                    tone="critical"
                    accessibilityLabel={`Remove ${collection.title}`}
                    onClick={() =>
                      setCollections((current) =>
                        current.filter((_, i) => i !== index),
                      )
                    }
                  />
                </InlineStack>
              </Box>
            ))}
          </BlockStack>
        )
      ) : paidItems.length === 0 ? (
        <Box padding="400">
          <Text as="p" tone="subdued" alignment="center">
            {type === "FIXED"
              ? "Add the products this bundle contains."
              : type === "QUANTITY_BREAKS"
                ? "Add the products this applies to."
                : "Add the products customers can pick from."}
          </Text>
        </Box>
      ) : (
        <BlockStack gap="300">
          {paidItems.map((item, index) => (
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
                  <BlockStack gap="050">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" variant="bodyMd" fontWeight="medium">
                        {item.productTitle}
                      </Text>
                      {item.missing && (
                        <Badge tone="critical">Deleted from store</Badge>
                      )}
                    </InlineStack>
                    {item.price != null && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        {formatMoney(item.price, shopCurrency)}
                        {type === "FIXED" && item.quantity > 1
                          ? ` × ${item.quantity} = ${formatMoney(item.price * item.quantity, shopCurrency)}`
                          : ""}
                      </Text>
                    )}
                  </BlockStack>
                </InlineStack>
                <InlineStack gap="200" blockAlign="center" wrap={false}>
                  {type === "FIXED" && (
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
                  )}
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
