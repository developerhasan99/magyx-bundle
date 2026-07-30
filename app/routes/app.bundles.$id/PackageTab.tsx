import { Text } from "@shopify/polaris";

// Solid, full-contrast colors matching the storefront widget's own badge
// palette (magyx-bundle.css's `--pack-badge--*`/`--tier-badge--*` rules) —
// kept in sync by hand so this preview shows merchants exactly what
// customers will see, not Polaris's default pale-tint Badge styling.
const BADGE_TONE_COLORS: Record<string, string> = {
  success: "#16a34a",
  info: "#2563eb",
  attention: "#ea580c",
  warning: "#d97706",
  critical: "#dc2626",
  new: "#9333ea",
};

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
        margin: selected ? "10px 1px 0" : "11px 1px 0",
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
        // Floats above the tab like the storefront gift cards' "VALUE" tag,
        // instead of sitting inline next to the label where long text wraps.
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "2px 8px",
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 700,
            lineHeight: 1.4,
            color: "#fff",
            background: BADGE_TONE_COLORS[badgeTone] ?? "#4a4a4a",
            whiteSpace: "nowrap",
          }}
        >
          {badgeText}
        </span>
      )}
    </button>
  );
}
