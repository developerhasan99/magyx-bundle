import { InlineStack, TextField, Select, Button } from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { PackageTab } from "./PackageTab";
import { BADGE_TONE_OPTIONS, type PackageState } from "./types";

/**
 * Just the row of package tabs. Pricing, products and gifts are all edited
 * per package but live in their own editor sections, so each of those repeats
 * this strip — without it the merchant can't tell which package they're
 * changing, or switch without navigating back to Packages.
 *
 * Renders nothing until there's more than one package to switch between.
 */
export function PackageTabsStrip({
  packages,
  activePackageIndex,
  setActivePackageIndex,
}: {
  packages: PackageState[];
  activePackageIndex: number;
  setActivePackageIndex: (index: number) => void;
}) {
  if (packages.length <= 1) return null;

  return (
    <InlineStack gap="200" wrap>
      {packages.map((pkg, index) => (
        <PackageTab
          key={pkg.id ?? pkg.tempKey}
          label={pkg.label}
          badgeText={pkg.badgeText}
          badgeTone={pkg.badgeTone}
          selected={index === activePackageIndex}
          onSelect={() => setActivePackageIndex(index)}
        />
      ))}
    </InlineStack>
  );
}

// The tab strip plus the active package's own label/badge fields — the
// Packages section's own content, as opposed to the bare strip above.
// Renders nothing until there's more than one package to switch between.
export function PackagesTabsSection({
  packages,
  activePackageIndex,
  setActivePackageIndex,
  updateActivePackage,
  removeActivePackage,
}: {
  packages: PackageState[];
  activePackageIndex: number;
  setActivePackageIndex: (index: number) => void;
  updateActivePackage: (patch: Partial<PackageState>) => void;
  removeActivePackage: () => void;
}) {
  if (packages.length <= 1) return null;

  return (
    <>
      <PackageTabsStrip
        packages={packages}
        activePackageIndex={activePackageIndex}
        setActivePackageIndex={setActivePackageIndex}
      />
      <InlineStack gap="300" wrap blockAlign="end">
        <div style={{ minWidth: 200, flex: 1 }}>
          <TextField
            label="Package title"
            value={packages[activePackageIndex]?.label ?? ""}
            onChange={(value) => updateActivePackage({ label: value })}
            autoComplete="off"
            placeholder="e.g. 2 Pack"
          />
        </div>
        <div style={{ width: 160 }}>
          <Select
            label="Badge"
            options={BADGE_TONE_OPTIONS}
            value={packages[activePackageIndex]?.badgeTone ?? ""}
            onChange={(value) => updateActivePackage({ badgeTone: value })}
          />
        </div>
        <div style={{ minWidth: 160, flex: 1 }}>
          <TextField
            label="Badge text"
            value={packages[activePackageIndex]?.badgeText ?? ""}
            onChange={(value) => updateActivePackage({ badgeText: value })}
            autoComplete="off"
            placeholder="e.g. Best value"
          />
        </div>
        <Button
          icon={DeleteIcon}
          variant="tertiary"
          tone="critical"
          accessibilityLabel="Remove package"
          disabled={packages.length <= 1}
          onClick={removeActivePackage}
        >
          Remove package
        </Button>
      </InlineStack>
    </>
  );
}
