import { useMemo, useState } from "react";
import {
  BlockStack,
  Banner,
  Box,
  Text,
  Select,
  TextField,
  Badge,
  InlineStack,
  Divider,
} from "@shopify/polaris";
import {
  HEADING_TEXT_KEY,
  SLOT_BUILDER_TEXT_DEFAULTS,
  SLOT_BUILDER_TEXT_FIELDS,
  slotBuilderTextGroups,
  type PackageTranslations,
  type SlotBuilderTranslations,
} from "../../utils/slot-builder-text";
import type { PackageState } from "./types";

export interface ShopLocaleOption {
  locale: string;
  name: string;
  primary: boolean;
}

/**
 * SLOT_BUILDER only: per-language overrides for every string the storefront
 * widget shows, plus each package's own label/badge/filter-chip copy.
 *
 * The merchant's primary language isn't editable here — that copy already
 * lives in the fields it belongs to (Appearance's heading, each package's
 * label), and duplicating it would give two places to change one string.
 * This card only handles the *additional* languages, and every field left
 * blank falls back: shopper's language → primary language → the widget's
 * built-in English.
 */
export function TranslationsSection({
  locales,
  translations,
  setTranslations,
  widgetHeading,
  packages,
  updatePackage,
}: {
  locales: ShopLocaleOption[];
  translations: SlotBuilderTranslations;
  setTranslations: (value: SlotBuilderTranslations) => void;
  /** Primary-language heading, shown as the placeholder for its overrides. */
  widgetHeading: string;
  packages: PackageState[];
  updatePackage: (index: number, patch: Partial<PackageState>) => void;
}) {
  const primaryLocale = locales.find((l) => l.primary);
  const secondaryLocales = useMemo(() => locales.filter((l) => !l.primary), [locales]);
  const [activeLocale, setActiveLocale] = useState(
    () => secondaryLocales[0]?.locale ?? "",
  );

  // An empty list means the lookup failed, not that the shop has no
  // languages — saying "one language (English)" here would be a confident
  // guess about something we don't know, and wrong on any non-English shop.
  if (locales.length === 0) {
    return (
      <BlockStack gap="300">
        <SectionHeading />
        <Banner tone="warning">
          <p>
            Couldn't load this store's languages, so there's nothing to
            translate into yet. Reload the page to try again — if it keeps
            happening, reopen the app from Shopify so it can request the
            permission it needs to read your language settings.
          </p>
        </Banner>
      </BlockStack>
    );
  }

  // Genuinely single-language: an explainer rather than an empty picker.
  if (secondaryLocales.length === 0) {
    return (
      <BlockStack gap="300">
        <SectionHeading />
        <Banner tone="info">
          <p>
            This store publishes one language
            {primaryLocale ? ` (${primaryLocale.name})` : ""}. Add more in Shopify
            Settings → Languages and they'll show up here to translate.
          </p>
        </Banner>
      </BlockStack>
    );
  }

  // A locale that disappeared from the shop between renders would leave the
  // Select with no matching option — fall back to the first available one.
  const selectedLocale = secondaryLocales.some((l) => l.locale === activeLocale)
    ? activeLocale
    : secondaryLocales[0].locale;
  const localeStrings = translations[selectedLocale] ?? {};

  const setString = (key: string, value: string) => {
    setTranslations({
      ...translations,
      [selectedLocale]: { ...localeStrings, [key]: value },
    });
  };

  const setPackageString = (
    index: number,
    field: "label" | "badgeText",
    value: string,
  ) => {
    const pkg = packages[index];
    const existing: PackageTranslations = pkg.translations ?? {};
    updatePackage(index, {
      translations: {
        ...existing,
        [selectedLocale]: { ...(existing[selectedLocale] ?? {}), [field]: value },
      },
    });
  };

  const setPackageChipLabel = (index: number, chipIndex: number, value: string) => {
    const pkg = packages[index];
    const existing: PackageTranslations = pkg.translations ?? {};
    const entry = existing[selectedLocale] ?? {};
    // Positional against the package's own tagFilters — pad with "" so an
    // untranslated chip in the middle keeps later chips on the right filter.
    const labels = pkg.tagFilters.map(
      (_, i) => entry.tagFilterLabels?.[i] ?? "",
    );
    labels[chipIndex] = value;
    updatePackage(index, {
      translations: {
        ...existing,
        [selectedLocale]: { ...entry, tagFilterLabels: labels },
      },
    });
  };

  // Only count fields the merchant filled in — the "N translated" badge is
  // meant to answer "have I finished this language?", so blanks don't count.
  const filledCount =
    SLOT_BUILDER_TEXT_FIELDS.filter((f) => localeStrings[f.key]?.trim()).length +
    (localeStrings[HEADING_TEXT_KEY]?.trim() ? 1 : 0);
  const totalCount = SLOT_BUILDER_TEXT_FIELDS.length + 1;

  return (
    <BlockStack gap="500">
      <SectionHeading />

      <InlineStack gap="300" blockAlign="end" wrap>
        <div style={{ minWidth: 240 }}>
          <Select
            label="Language"
            options={secondaryLocales.map((l) => ({
              label: l.name,
              value: l.locale,
            }))}
            value={selectedLocale}
            onChange={setActiveLocale}
            helpText={
              primaryLocale
                ? `Anything left blank falls back to ${primaryLocale.name}.`
                : "Anything left blank falls back to your default language."
            }
          />
        </div>
        <Box paddingBlockEnd="600">
          <Badge tone={filledCount === totalCount ? "success" : undefined}>
            {`${filledCount} of ${totalCount} translated`}
          </Badge>
        </Box>
      </InlineStack>

      <Divider />

      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          Heading
        </Text>
        <TextField
          label="Widget heading"
          value={localeStrings[HEADING_TEXT_KEY] ?? ""}
          onChange={(value) => setString(HEADING_TEXT_KEY, value)}
          placeholder={widgetHeading || "Not set"}
          autoComplete="off"
          disabled={!widgetHeading}
          helpText={
            widgetHeading
              ? undefined
              : "Set a heading in Appearance before translating it."
          }
        />
      </BlockStack>

      {packages.length > 0 && (
        <>
          <Divider />
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Packages
            </Text>
            {packages.map((pkg, index) => {
              const entry = pkg.translations?.[selectedLocale] ?? {};
              return (
                <BlockStack gap="200" key={pkg.tempKey}>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {pkg.label || `Package ${index + 1}`}
                  </Text>
                  <TextField
                    label="Package label"
                    labelHidden
                    value={entry.label ?? ""}
                    onChange={(value) => setPackageString(index, "label", value)}
                    placeholder={pkg.label}
                    autoComplete="off"
                  />
                  {pkg.badgeText.trim() !== "" && (
                    <TextField
                      label="Badge"
                      labelHidden
                      value={entry.badgeText ?? ""}
                      onChange={(value) => setPackageString(index, "badgeText", value)}
                      placeholder={pkg.badgeText}
                      autoComplete="off"
                    />
                  )}
                  {/* Only the chip's button text is translatable — the product
                      tag it matches is store data, not customer-facing copy. */}
                  {pkg.tagFilters.map((filter, chipIndex) => (
                    <TextField
                      key={`${pkg.tempKey}-chip-${chipIndex}`}
                      label={`Filter chip: ${filter.label}`}
                      labelHidden
                      value={entry.tagFilterLabels?.[chipIndex] ?? ""}
                      onChange={(value) => setPackageChipLabel(index, chipIndex, value)}
                      placeholder={filter.label}
                      autoComplete="off"
                    />
                  ))}
                </BlockStack>
              );
            })}
          </BlockStack>
        </>
      )}

      {slotBuilderTextGroups().map((group) => (
        <BlockStack gap="300" key={group}>
          <Divider />
          <Text as="h3" variant="headingSm">
            {group}
          </Text>
          {SLOT_BUILDER_TEXT_FIELDS.filter((field) => field.group === group).map(
            (field) => (
              <TextField
                key={field.key}
                label={field.label}
                value={localeStrings[field.key] ?? ""}
                onChange={(value) => setString(field.key, value)}
                placeholder={SLOT_BUILDER_TEXT_DEFAULTS[field.key]}
                autoComplete="off"
                helpText={field.help}
              />
            ),
          )}
        </BlockStack>
      ))}
    </BlockStack>
  );
}

function SectionHeading() {
  return (
    <BlockStack gap="100">
      <Text as="h2" variant="headingMd">
        Translations
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        Storefront copy for each of your published languages. Shoppers see the
        translation matching their language, falling back to your default one.
      </Text>
    </BlockStack>
  );
}
