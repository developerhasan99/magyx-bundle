import { BlockStack, Text, InlineGrid, InlineStack, TextField, Checkbox } from "@shopify/polaris";
import { WidgetStyleCard } from "./WidgetStyleCard";
import { AccentColorPicker } from "./AccentColorPicker";
import { WIDGET_STYLE_OPTIONS } from "./types";

// FIXED bundles only: storefront "what's inside" widget appearance.
export function FixedAppearanceSection({
  widgetStyle,
  setWidgetStyle,
  accentColor,
  setAccentColor,
  widgetHeading,
  setWidgetHeading,
  showPrices,
  setShowPrices,
  itemSubtextTemplate,
  setItemSubtextTemplate,
  showSubtextOnGifts,
  setShowSubtextOnGifts,
  showSkipCartOption = false,
  skipCart = false,
  setSkipCart,
}: {
  widgetStyle: string;
  setWidgetStyle: (value: string) => void;
  accentColor: string;
  setAccentColor: (value: string) => void;
  widgetHeading: string;
  setWidgetHeading: (value: string) => void;
  showPrices: boolean;
  setShowPrices: (value: boolean) => void;
  itemSubtextTemplate: string;
  setItemSubtextTemplate: (value: string) => void;
  showSubtextOnGifts: boolean;
  setShowSubtextOnGifts: (value: boolean) => void;
  // SLOT_BUILDER only — FIXED bundles never pass this true
  showSkipCartOption?: boolean;
  skipCart?: boolean;
  setSkipCart?: (value: boolean) => void;
}) {
  return (
    <BlockStack gap="400">
      <Text as="h2" variant="headingMd">
        Appearance
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        Controls the &quot;what&apos;s inside&quot; widget shown on this
        bundle&apos;s product page. There&apos;s nothing to set up in the
        theme editor — everything lives here.
      </Text>
      <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
        {WIDGET_STYLE_OPTIONS.map((option) => (
          <WidgetStyleCard
            key={option.value}
            label={option.label}
            description={option.description}
            style={option.value}
            accent={accentColor}
            selected={widgetStyle === option.value}
            onSelect={() => setWidgetStyle(option.value)}
          />
        ))}
      </InlineGrid>
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
      <Checkbox
        label="Show item prices"
        checked={showPrices}
        onChange={setShowPrices}
        helpText="Free gifts will also show a “Free gift” badge."
      />
      <TextField
        label="Item subtext"
        value={itemSubtextTemplate}
        onChange={setItemSubtextTemplate}
        autoComplete="off"
        placeholder="e.g. SKU: {{sku}} · {{metafield:custom.material}}"
        helpText="Optional line shown under each product's title. Insert {{sku}}, {{vendor}}, {{type}}, {{barcode}}, {{weight}}, {{metafield:namespace.key}}, or — for a metaobject reference — {{metafield:namespace.key.value.field}}. Resolved per product when you save."
      />
      <Checkbox
        label="Show subtext on free gifts"
        checked={showSubtextOnGifts}
        onChange={setShowSubtextOnGifts}
        helpText="Turn off to hide the subtext line for items marked as a free gift."
      />
      {showSkipCartOption && setSkipCart && (
        <Checkbox
          label="Skip Cart — go directly to checkout after adding to cart"
          checked={skipCart}
          onChange={setSkipCart}
          helpText="When off, adding this bundle behaves like the theme's own Add to Cart button. When on, the bundle gets its own button that adds to cart and sends the customer straight to checkout."
        />
      )}
    </BlockStack>
  );
}
