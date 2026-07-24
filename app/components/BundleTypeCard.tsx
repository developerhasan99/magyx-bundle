import { BlockStack, InlineStack, Text, Badge } from "@shopify/polaris";

export function RadioIndicator({ selected }: { selected: boolean }) {
  return (
    <span
      style={{
        width: 16,
        height: 16,
        flexShrink: 0,
        borderRadius: "50%",
        border: selected
          ? "5px solid var(--p-color-border-emphasis)"
          : "2px solid var(--p-color-border)",
        background: "var(--p-color-bg-surface)",
        transition: "border 100ms ease",
      }}
    />
  );
}

export function BundleTypeCard({
  label,
  description,
  selected,
  disabled,
  badge,
  onSelect,
}: {
  label: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  // Optional label shown next to the title, e.g. "Coming soon" for types
  // that don't have a builder yet — implies disabled but reads clearer.
  badge?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      style={{
        // Buttons vertically center their content by default; pin it to the
        // top so equal-height cards in the grid stay top-aligned
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        justifyContent: "flex-start",
        textAlign: "left",
        color: "var(--p-color-text)",
        padding: "var(--p-space-300)",
        borderRadius: "var(--p-border-radius-300)",
        border: selected
          ? "2px solid var(--p-color-border-emphasis)"
          : "1px solid var(--p-color-border)",
        // 1px compensation keeps unselected cards the same size as the
        // selected one despite the thinner border
        margin: selected ? 0 : 1,
        background: selected
          ? "var(--p-color-bg-surface-selected)"
          : "var(--p-color-bg-surface)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled && !selected ? 0.5 : 1,
        transition: "border-color 100ms ease, background 100ms ease",
      }}
    >
      <BlockStack gap="100">
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <RadioIndicator selected={selected} />
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {label}
          </Text>
          {badge && (
            <Badge size="small" tone="info">
              {badge}
            </Badge>
          )}
        </InlineStack>
        <Text as="span" variant="bodySm" tone="subdued">
          {description}
        </Text>
      </BlockStack>
    </button>
  );
}
