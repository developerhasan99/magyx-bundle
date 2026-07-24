import { InlineStack, TextField, Select, Button } from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { PackageTab } from "./PackageTab";
import { BADGE_TONE_OPTIONS, type PackageState } from "./types";

// FIXED bundles only: package tabs + label/badge fields for the active one.
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
