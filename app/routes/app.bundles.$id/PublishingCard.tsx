import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Thumbnail,
  Box,
  Select,
  TextField,
  Button,
  type BadgeProps,
} from "@shopify/polaris";
import { ImageIcon, EditIcon } from "@shopify/polaris-icons";
import { formatMoney } from "../../utils/money";

interface ShopifyProductPreview {
  title: string;
  status: string;
  imageUrl: string | null;
  price: string | null;
  previewUrl: string | null;
}

// Everything that differs per bundle type in this card. A lookup rather than
// three parallel ternaries so a new bundle type is one entry, not three edits
// that can quietly disagree with each other.
const BUNDLE_TYPE_META: Record<
  string,
  { label: string; tone: BadgeProps["tone"]; statusHelp: string }
> = {
  FIXED: {
    label: "Fixed",
    tone: "info",
    statusHelp:
      "When set to Active, Magyx Bundle creates a bundle product in your store. It's expanded into its components at checkout, so inventory stays accurate.",
  },
  SLOT_BUILDER: {
    label: "Build a box",
    tone: "attention",
    statusHelp:
      "When set to Active, Magyx Bundle creates a bundle product. Customers fill its slots from your pool, and it's expanded into their picks at checkout, so inventory stays accurate.",
  },
  QUANTITY_BREAKS: {
    label: "Quantity breaks",
    tone: "success",
    statusHelp:
      "When set to Active, the quantity breaks widget shows automatically on this product's page once you've added the theme block — no separate product is created, and discounts apply automatically at checkout.",
  },
  MIX_MATCH: {
    label: "Mix & match",
    tone: "magic",
    statusHelp:
      "When set to Active, the mix & match builder becomes available as an app block in your theme editor, and discounts apply automatically at checkout.",
  },
};

/**
 * Status, the bundle's type, and — once published — a link to the Shopify
 * product it created. Sits at the top of the editor's single column: the type
 * chip is what identifies the page at a glance, so it has to be somewhere the
 * merchant sees without scrolling.
 */
export function PublishingCard({
  type,
  shopCurrency,
  status,
  setStatus,
  isNew,
  bundleId,
  shopifyProductId,
  shopifyProduct,
  editBundleProduct,
  onCopyBundleId,
}: {
  type: string;
  shopCurrency: string;
  status: string;
  setStatus: (value: string) => void;
  isNew: boolean;
  bundleId: string | undefined;
  shopifyProductId: string | null | undefined;
  shopifyProduct: ShopifyProductPreview | null;
  editBundleProduct: () => void;
  onCopyBundleId: () => void;
}) {
  const meta = BUNDLE_TYPE_META[type] ?? BUNDLE_TYPE_META.MIX_MATCH;

  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Publishing
          </Text>
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </InlineStack>
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
          {meta.statusHelp}
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
                          {formatMoney(parseFloat(shopifyProduct.price), shopCurrency)}
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
  );
}
