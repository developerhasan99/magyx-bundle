import {
  BlockStack,
  Text,
  InlineGrid,
  InlineStack,
  TextField,
  Checkbox,
  Divider,
} from "@shopify/polaris";
import { WidgetStyleCard } from "./WidgetStyleCard";
import { AccentColorPicker } from "./AccentColorPicker";
import { WIDGET_STYLE_OPTIONS } from "./types";

// Storefront widget appearance for the two types that publish a product page
// widget: FIXED ("what's inside") and SLOT_BUILDER (the box builder).
// Grouped into subsections so the type-specific controls (layout picker,
// checkout behavior) read as distinct choices rather than one flat list.
export function AppearanceSection({
  type,
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
  skipCart = false,
  setSkipCart,
  autoCheckout = false,
  setAutoCheckout,
}: {
  type: string;
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
  // SLOT_BUILDER only — FIXED bundles never pass these
  skipCart?: boolean;
  setSkipCart?: (value: boolean) => void;
  autoCheckout?: boolean;
  setAutoCheckout?: (value: boolean) => void;
}) {
  const isSlotBuilder = type === "SLOT_BUILDER";
  // The layout picker only drives the "what's inside" widget — Build a box
  // has a single design, and publishSlotBuilderBundleProduct never sends
  // `style` in its widget settings, so showing it there would be dead UI.
  const showLayoutPicker = !isSlotBuilder;

  return (
    <BlockStack gap="500">
      <BlockStack gap="100">
        <Text as="h2" variant="headingMd">
          Appearance
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {isSlotBuilder
            ? "How the box builder looks on this bundle's product page. Every option lives here, not in the theme editor."
            : "How the “what's inside” list looks on this bundle's product page. Every option lives here, not in the theme editor."}
        </Text>
      </BlockStack>

      {showLayoutPicker && (
        <>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Layout
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
          </BlockStack>
          <Divider />
        </>
      )}

      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          Heading &amp; color
        </Text>
        <InlineStack gap="400" wrap>
          <div style={{ minWidth: 220, flex: 1 }}>
            <TextField
              label="Heading"
              value={widgetHeading}
              onChange={setWidgetHeading}
              autoComplete="off"
              helpText="Shown above the widget. Leave empty to hide it."
            />
          </div>
          <AccentColorPicker accentColor={accentColor} onChange={setAccentColor} />
        </InlineStack>
      </BlockStack>

      <Divider />

      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          Product details
        </Text>
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
      </BlockStack>

      {isSlotBuilder && setSkipCart && (
        <>
          <Divider />
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Checkout
            </Text>
            <Checkbox
              label="Skip cart and go straight to checkout"
              checked={skipCart}
              onChange={setSkipCart}
              helpText="Off (default): if this product's page has your theme's own native Add to Cart button, adding to cart uses that button, so cart drawer and quick-add behave the same as they do everywhere else on your store. If it doesn't, the widget falls back to a button of its own that adds to cart and goes straight to checkout. On: this widget always shows its own button, which adds to cart and goes straight to checkout — skipping the cart entirely, in every case."
            />
            {setAutoCheckout && (
              <Checkbox
                label="Go to checkout as soon as the last slot is filled"
                checked={autoCheckout}
                onChange={setAutoCheckout}
                // Auto checkout drives the widget's own button, which only
                // exists when Skip cart is on — see the widget's `ctaMode`.
                disabled={!skipCart}
                helpText={
                  skipCart
                    ? "The customer doesn't press anything: filling the final slot adds the bundle to the cart and sends them to checkout, exactly as if they had pressed the button themselves. If that add fails, the button reappears so they can retry."
                    : "Requires “Skip cart and go straight to checkout” above."
                }
              />
            )}
          </BlockStack>
        </>
      )}
    </BlockStack>
  );
}
