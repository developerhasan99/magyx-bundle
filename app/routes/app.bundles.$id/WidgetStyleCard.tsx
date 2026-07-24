import { BlockStack, InlineStack, Text, Box } from "@shopify/polaris";
import { RadioIndicator } from "../../components/BundleTypeCard";
import type { WIDGET_STYLE_OPTIONS } from "./types";

type WidgetStyleValue = (typeof WIDGET_STYLE_OPTIONS)[number]["value"];

// Miniature mockup of each storefront widget style, so merchants can see the
// shape of the layout (and how their accent color reads) before saving.
export function WidgetStylePreview({
  style,
  accent,
}: {
  style: WidgetStyleValue;
  accent: string;
}) {
  if (style === "grid") {
    return (
      <InlineStack gap="150">
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ flex: 1 }}>
            <div
              style={{
                aspectRatio: "1",
                borderRadius: 6,
                background: "#e7e7e7",
                marginBottom: 4,
              }}
            />
            <div
              style={{
                height: 5,
                borderRadius: 3,
                background: "#dcdcdc",
                marginBottom: 3,
              }}
            />
            <div style={{ height: 5, width: "55%", borderRadius: 3, background: accent }} />
          </div>
        ))}
      </InlineStack>
    );
  }

  if (style === "minimal") {
    return (
      <BlockStack gap="150">
        {[0, 1, 2].map((i) => (
          <InlineStack key={i} gap="150" blockAlign="center" wrap={false}>
            <div
              style={{
                width: 14,
                height: 14,
                flexShrink: 0,
                borderRadius: "50%",
                background: accent,
                color: "#fff",
                fontSize: 9,
                lineHeight: "14px",
                textAlign: "center",
              }}
            >
              ✓
            </div>
            <div
              style={{
                width: 20,
                height: 20,
                flexShrink: 0,
                borderRadius: 5,
                background: "#e7e7e7",
              }}
            />
            <div style={{ flex: 1, height: 5, borderRadius: 3, background: "#dcdcdc" }} />
          </InlineStack>
        ))}
      </BlockStack>
    );
  }

  return (
    <BlockStack gap="150">
      {[0, 1, 2].map((i) => (
        <InlineStack key={i} gap="150" blockAlign="center" wrap={false}>
          <div style={{ position: "relative", flexShrink: 0, width: 26, height: 26 }}>
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: 7,
                background: "#e7e7e7",
              }}
            />
            <div
              style={{
                position: "absolute",
                top: -4,
                left: -4,
                width: 13,
                height: 13,
                borderRadius: 4,
                background: accent,
                color: "#fff",
                fontSize: 8,
                fontWeight: 700,
                lineHeight: "13px",
                textAlign: "center",
              }}
            >
              {i + 1}
            </div>
          </div>
          <div style={{ flex: 1, height: 5, borderRadius: 3, background: "#dcdcdc" }} />
        </InlineStack>
      ))}
    </BlockStack>
  );
}

export function WidgetStyleCard({
  label,
  description,
  style,
  accent,
  selected,
  onSelect,
}: {
  label: string;
  description: string;
  style: WidgetStyleValue;
  accent: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        textAlign: "left",
        color: "var(--p-color-text)",
        padding: "var(--p-space-300)",
        borderRadius: "var(--p-border-radius-300)",
        border: selected
          ? "2px solid var(--p-color-border-emphasis)"
          : "1px solid var(--p-color-border)",
        margin: selected ? 0 : 1,
        background: selected
          ? "var(--p-color-bg-surface-selected)"
          : "var(--p-color-bg-surface)",
        cursor: "pointer",
        transition: "border-color 100ms ease, background 100ms ease",
      }}
    >
      <BlockStack gap="300">
        <Box
          background="bg-surface"
          borderRadius="200"
          borderColor="border"
          borderWidth="025"
          padding="300"
        >
          <WidgetStylePreview style={style} accent={accent} />
        </Box>
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <RadioIndicator selected={selected} />
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {label}
            </Text>
          </InlineStack>
          <Text as="span" variant="bodySm" tone="subdued">
            {description}
          </Text>
        </BlockStack>
      </BlockStack>
    </button>
  );
}
