import { BlockStack, InlineStack, Text, Badge } from "@shopify/polaris";
import styles from "./BundleTypeCard.module.css";

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
      className={selected ? `${styles.card} ${styles.selected}` : styles.card}
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
