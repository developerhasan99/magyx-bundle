import { BlockStack, Text, InlineStack, TextField, Divider, Button } from "@shopify/polaris";
import { DeleteIcon, PlusIcon } from "@shopify/polaris-icons";
import type { TierState } from "./types";

// MIX_MATCH only: minimum/maximum items + discount tiers.
export function MixMatchRulesSection({
  minItems,
  setMinItems,
  maxItems,
  setMaxItems,
  tiers,
  setTiers,
}: {
  minItems: string;
  setMinItems: (value: string) => void;
  maxItems: string;
  setMaxItems: (value: string) => void;
  tiers: TierState[];
  setTiers: (updater: (current: TierState[]) => TierState[]) => void;
}) {
  return (
    <BlockStack gap="400">
      <Text as="h2" variant="headingMd">
        Rules &amp; discount tiers
      </Text>
      <InlineStack gap="400">
        <div style={{ width: 140 }}>
          <TextField
            label="Minimum items"
            type="number"
            min={1}
            value={minItems}
            onChange={setMinItems}
            autoComplete="off"
          />
        </div>
        <div style={{ width: 140 }}>
          <TextField
            label="Maximum items"
            type="number"
            value={maxItems}
            onChange={setMaxItems}
            autoComplete="off"
            placeholder="No limit"
          />
        </div>
      </InlineStack>
      <Divider />
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          Discount tiers
        </Text>
        {tiers.map((tier, index) => (
          <InlineStack key={index} gap="200" blockAlign="end" wrap={false}>
            <div style={{ width: 140 }}>
              <TextField
                label="Buy at least"
                type="number"
                min={1}
                value={tier.quantity}
                onChange={(value) =>
                  setTiers((current) =>
                    current.map((t, i) => (i === index ? { ...t, quantity: value } : t)),
                  )
                }
                autoComplete="off"
                suffix="items"
              />
            </div>
            <div style={{ width: 140 }}>
              <TextField
                label="Get discount"
                type="number"
                min={0}
                value={tier.discount}
                onChange={(value) =>
                  setTiers((current) =>
                    current.map((t, i) => (i === index ? { ...t, discount: value } : t)),
                  )
                }
                autoComplete="off"
                suffix="%"
              />
            </div>
            <Button
              icon={DeleteIcon}
              variant="tertiary"
              accessibilityLabel="Remove tier"
              onClick={() => setTiers((current) => current.filter((_, i) => i !== index))}
              disabled={tiers.length === 1}
            />
          </InlineStack>
        ))}
        <div>
          <Button
            icon={PlusIcon}
            variant="plain"
            onClick={() =>
              setTiers((current) => [...current, { quantity: "", discount: "" }])
            }
          >
            Add tier
          </Button>
        </div>
      </BlockStack>
    </BlockStack>
  );
}
