import {
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  Divider,
  Thumbnail,
  Badge,
  TextField,
  ChoiceList,
} from "@shopify/polaris";
import { DeleteIcon, ImageIcon, PlusIcon } from "@shopify/polaris-icons";
import { BundleTypeCard } from "../../components/BundleTypeCard";
import { formatMoney } from "../../utils/money";
import {
  POOL_SOURCE_OPTIONS,
  QUANTITY_BREAK_SCOPE_OPTIONS,
  type CollectionState,
  type ItemState,
  type ResolvedPoolItem,
  type TagFilterState,
} from "./types";

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
  collectionPoolItems,
  variantFilter,
  setVariantFilter,
  tagFilters,
  setTagFilters,
  onResolveProducts,
  isResolvingPool,
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
  collectionPoolItems: ResolvedPoolItem[];
  // SLOT_BUILDER only — undefined for MIX_MATCH/QUANTITY_BREAKS, which don't
  // offer this filter (or the resolve button) yet.
  variantFilter?: string;
  setVariantFilter?: (value: string) => void;
  // SLOT_BUILDER only: the storefront pool-modal's tag filter chips — one
  // row per category (button text + the exact product tag it matches).
  tagFilters?: TagFilterState[];
  setTagFilters?: (updater: (current: TagFilterState[]) => TagFilterState[]) => void;
  onResolveProducts?: () => void;
  isResolvingPool?: boolean;
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
              : "Product pool — customers pick from"}
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
        /* Plain radios, not selection cards. For Build a box this sits
           directly under the pool-mode cards, and two identical card grids
           stacked read as one control with four options rather than two
           separate decisions. */
        type !== "FIXED" && (
          <ChoiceList
            title="Where the pool comes from"
            titleHidden
            choices={POOL_SOURCE_OPTIONS.map((option) => ({
              label: option.label,
              value: option.value,
              helpText: option.helpText,
            }))}
            selected={[poolSource]}
            onChange={([value]) => setPoolSource(value)}
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
      ) : null}
      {showCollectionPool && collections.length > 0 && setVariantFilter && (
        <BlockStack gap="100">
          <Text as="p" variant="bodyMd">
            Only include variants whose title contains
          </Text>
          <InlineStack gap="200" blockAlign="stretch" wrap={false}>
            <div style={{ flex: 1 }}>
              <TextField
                label="Only include variants whose title contains"
                labelHidden
                value={variantFilter ?? ""}
                onChange={setVariantFilter}
                autoComplete="off"
                placeholder="e.g. 50ml, Large"
                clearButton
                onClearButtonClick={() => setVariantFilter("")}
              />
            </div>
            <Button onClick={onResolveProducts} loading={isResolvingPool}>
              Resolve products
            </Button>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            Leave blank to include every variant. Matches anywhere in the
            variant title, not case-sensitive — e.g. "50" matches "50ml".
          </Text>
        </BlockStack>
      )}
      {showCollectionPool && collections.length > 0 && (
        <BlockStack gap="300">
          <Divider />
          <Text as="h3" variant="headingSm">
            {collectionPoolItems.length === 0
              ? "Resolved products"
              : `Resolved products (${collectionPoolItems.length})`}
          </Text>
          {collectionPoolItems.length === 0 ? (
            <Box padding="400">
              <Text as="p" tone="subdued" alignment="center">
                Click "Resolve products" to preview which products and
                variants will appear in the pool with the current settings.
              </Text>
            </Box>
          ) : (
            <BlockStack gap="300">
              {collectionPoolItems.map((item, index) => (
                <Box key={item.variantId}>
                  {index > 0 && <Box paddingBlockEnd="300"><Divider /></Box>}
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <Thumbnail
                      source={item.imageUrl || ImageIcon}
                      alt={item.title}
                      size="small"
                    />
                    <BlockStack gap="050">
                      <Text as="span" variant="bodyMd" fontWeight="medium">
                        {item.title}
                      </Text>
                      {item.price != null && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          {formatMoney(item.price, shopCurrency)}
                          {!item.available ? " · Out of stock" : ""}
                        </Text>
                      )}
                    </BlockStack>
                  </InlineStack>
                </Box>
              ))}
            </BlockStack>
          )}
        </BlockStack>
      )}
      {!showCollectionPool && (paidItems.length === 0 ? (
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
      ))}
      {tagFilters && setTagFilters && (
        <BlockStack gap="300">
          <Divider />
          <BlockStack gap="100">
            {/* Heading and button share one row — same as every other section
                header here. The description sits below rather than inside the
                row: at three lines it pushed the button onto its own line. */}
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingSm">
                Filter buttons
              </Text>
              <Button
                icon={PlusIcon}
                onClick={() =>
                  setTagFilters((current) => [...current, { label: "", tag: "" }])
                }
              >
                Add filter
              </Button>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              Shown as round buttons in the product-pick window, before the
              search field. Customers tap one to narrow the pool to products
              carrying that tag — an &quot;All&quot; button is added
              automatically.
            </Text>
          </BlockStack>
          {tagFilters.length > 0 && (
            <BlockStack gap="200">
              {tagFilters.map((filter, index) => (
                <InlineStack key={index} gap="200" blockAlign="start" wrap={false}>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Button text"
                      labelHidden={index > 0}
                      value={filter.label}
                      onChange={(value) =>
                        setTagFilters((current) =>
                          current.map((f, i) => (i === index ? { ...f, label: value } : f)),
                        )
                      }
                      autoComplete="off"
                      placeholder="e.g. Serums"
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Product tag"
                      labelHidden={index > 0}
                      value={filter.tag}
                      onChange={(value) =>
                        setTagFilters((current) =>
                          current.map((f, i) => (i === index ? { ...f, tag: value } : f)),
                        )
                      }
                      autoComplete="off"
                      placeholder="e.g. serum"
                      helpText={
                        index === tagFilters.length - 1
                          ? "Must exactly match a tag on the product (not case-sensitive)."
                          : undefined
                      }
                    />
                  </div>
                  <Box paddingBlockStart={index === 0 ? "600" : "0"}>
                    <Button
                      icon={DeleteIcon}
                      variant="tertiary"
                      tone="critical"
                      accessibilityLabel={`Remove filter ${filter.label || index + 1}`}
                      onClick={() =>
                        setTagFilters((current) => current.filter((_, i) => i !== index))
                      }
                    />
                  </Box>
                </InlineStack>
              ))}
            </BlockStack>
          )}
        </BlockStack>
      )}
    </BlockStack>
  );
}
