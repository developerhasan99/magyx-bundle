import { BundleTypeCard } from "../../components/BundleTypeCard";
import { POOL_MODE_OPTIONS } from "./types";

/**
 * SLOT_BUILDER only: one shared product pool, or a pool per package.
 *
 * Renders above everything else in the Product pool section — including the
 * package tabs, which it decides the existence of. Below them it would read
 * as a per-package setting, which is exactly what it isn't.
 */
export function PoolModeSelector({
  poolMode,
  setPoolMode,
}: {
  poolMode: string;
  setPoolMode: (value: string) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: "var(--p-space-300)",
      }}
    >
      {POOL_MODE_OPTIONS.map((option) => (
        <BundleTypeCard
          key={option.value}
          label={option.label}
          description={option.helpText}
          selected={poolMode === option.value}
          disabled={false}
          onSelect={() => setPoolMode(option.value)}
        />
      ))}
    </div>
  );
}
