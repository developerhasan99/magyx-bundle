import { BlockStack, Text, InlineStack, TextField } from "@shopify/polaris";
import { AccentColorPicker } from "./AccentColorPicker";

export function QuantityBreaksWidgetSection({
  widgetHeading,
  setWidgetHeading,
  accentColor,
  setAccentColor,
}: {
  widgetHeading: string;
  setWidgetHeading: (value: string) => void;
  accentColor: string;
  setAccentColor: (value: string) => void;
}) {
  return (
    <BlockStack gap="400">
      <Text as="h2" variant="headingMd">
        Storefront widget
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        Add the &quot;Quantity Breaks&quot; block to your product page template
        once in the theme editor — it shows automatically on this product
        while the bundle is Active. Nothing else to configure per product.
      </Text>
      <InlineStack gap="400" wrap>
        <div style={{ minWidth: 220, flex: 1 }}>
          <TextField
            label="Heading"
            value={widgetHeading}
            onChange={setWidgetHeading}
            autoComplete="off"
          />
        </div>
        <AccentColorPicker accentColor={accentColor} onChange={setAccentColor} />
      </InlineStack>
    </BlockStack>
  );
}
