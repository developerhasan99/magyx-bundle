import { BlockStack, InlineStack, Text, TextField } from "@shopify/polaris";

// Color-swatch-plus-textfield control shared by the FIXED Appearance card
// and the QUANTITY_BREAKS storefront widget card.
export function AccentColorPicker({
  accentColor,
  onChange,
}: {
  accentColor: string;
  onChange: (value: string) => void;
}) {
  return (
    <BlockStack gap="100">
      <Text as="span" variant="bodyMd">
        Accent color
      </Text>
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        <div
          style={{
            width: 36,
            height: 36,
            flexShrink: 0,
            borderRadius: 8,
            overflow: "hidden",
            border: "1px solid var(--p-color-border)",
          }}
        >
          <input
            type="color"
            value={/^#[0-9a-fA-F]{6}$/.test(accentColor) ? accentColor : "#1a1a1a"}
            onChange={(event) => onChange(event.target.value)}
            aria-label="Accent color"
            style={{
              width: "calc(100% + 16px)",
              height: "calc(100% + 16px)",
              margin: -8,
              padding: 0,
              border: "none",
              cursor: "pointer",
            }}
          />
        </div>
        <div style={{ width: 110 }}>
          <TextField
            label="Accent color"
            labelHidden
            value={accentColor}
            onChange={onChange}
            autoComplete="off"
          />
        </div>
      </InlineStack>
    </BlockStack>
  );
}
