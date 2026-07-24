import { Text, Badge } from "@shopify/polaris";

// Pill-style tab used by both FIXED packages and QUANTITY_BREAKS pack sizes.
export function PackageTab({
  label,
  badgeText,
  badgeTone,
  selected,
  onSelect,
}: {
  label: string;
  badgeText: string;
  badgeTone: string;
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
        alignItems: "center",
        gap: "var(--p-space-150)",
        padding: "var(--p-space-150) var(--p-space-300)",
        borderRadius: "var(--p-border-radius-full)",
        border: selected
          ? "2px solid var(--p-color-border-emphasis)"
          : "1px solid var(--p-color-border)",
        margin: selected ? 0 : 1,
        background: selected
          ? "var(--p-color-bg-surface-selected)"
          : "var(--p-color-bg-surface)",
        cursor: "pointer",
        color: "var(--p-color-text)",
        transition: "border-color 100ms ease, background 100ms ease",
      }}
    >
      <Text as="span" variant="bodySm" fontWeight={selected ? "semibold" : "regular"}>
        {label || "Untitled package"}
      </Text>
      {badgeText && (
        <Badge tone={(badgeTone || undefined) as "info" | "success" | "attention" | "warning" | "critical" | "new" | undefined} size="small">
          {badgeText}
        </Badge>
      )}
    </button>
  );
}
