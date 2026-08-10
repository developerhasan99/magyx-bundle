import { useState } from "react";
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
  DESCRIPTION_TEXT_KEY,
  HEADING_TEXT_KEY,
  PACK_PRICE_TEXT_KEY,
  PRICE_PER_UNIT_TEXT_KEY,
  ITEM_SUBTEXT_TEXT_KEY,
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
  /** Unpublished languages are still listed, so copy can be written before
      the language is switched on in Shopify. */
  published: boolean;
}

/**
 * SLOT_BUILDER only: per-language copy for every string the storefront widget
 * shows, plus each package's own label/badge/filter-chip text.
 *
 * Every language the shop has is listed, including the primary one and any
 * that aren't published yet. The primary matters because the widget's own
 * built-in copy is English: a shop whose default language is Swedish has no
 * other place to write Swedish chrome, and would otherwise be stuck with
 * English no matter what it did. Unpublished languages are listed so copy can
 * be prepared before the language goes live.
 *
 * Resolution at render time: shopper's language → primary language → the
 * widget's built-in English. Every field left blank falls through.
 */
export function TranslationsSection({
  locales,
  translations,
  setTranslations,
  widgetHeading,
  widgetDescription,
  packPriceTemplate,
  pricePerUnitTemplate,
  itemSubtextTemplate,
  packages,
  updatePackage,
}: {
  locales: ShopLocaleOption[];
  translations: SlotBuilderTranslations;
  setTranslations: (value: SlotBuilderTranslations) => void;
  /** Primary-language heading, shown as the placeholder for its overrides. */
  widgetHeading: string;
  /** Primary-language description line, likewise. */
  widgetDescription: string;
  /** Primary-language package tab price template, likewise. */
  packPriceTemplate: string;
  /** Primary-language per-item line, likewise — but this one is a normal
      catalogue key, so it's edited in its own group below rather than here. */
  pricePerUnitTemplate: string;
  /** Primary-language subtext template, likewise. */
  itemSubtextTemplate: string;
  packages: PackageState[];
  updatePackage: (index: number, patch: Partial<PackageState>) => void;
}) {
  const primaryLocale = locales.find((l) => l.primary);
  // Starts on the primary language. On a single-language shop that's the only
  // option, and it's the one whose copy every shopper sees by default.
  const [activeLocale, setActiveLocale] = useState(
    () => primaryLocale?.locale ?? locales[0]?.locale ?? "",
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

  // A locale that disappeared from the shop between renders would leave the
  // Select with no matching option — fall back to the first available one.
  const selectedLocale = locales.some((l) => l.locale === activeLocale)
    ? activeLocale
    : locales[0].locale;
  const localeStrings = translations[selectedLocale] ?? {};

  /* Editing the shop's own default language. The widget's built-in copy is
     English, so without this a Swedish-only shop could never get Swedish
     chrome — there'd be nowhere to type it, and the widget would fall through
     to its English defaults.

     The heading and the package label/badge/chip fields are hidden in this
     mode on purpose: for the default language those already live in the
     Storefront and General sections, and offering them twice would give one
     string two homes that could disagree. */
  const isPrimarySelected = selectedLocale === primaryLocale?.locale;

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
  // The subtext only counts where there's a template to translate — a bundle
  // that doesn't use one shouldn't be permanently one short of finished.
  const countsSubtext = !isPrimarySelected && itemSubtextTemplate.trim() !== "";
  // Same rule for the description line, which is optional in the same way.
  const countsDescription = !isPrimarySelected && widgetDescription.trim() !== "";
  // And for the pack tab price line — see the field itself for why a blank
  // one (i.e. the built-in all-shortcodes default) has nothing to translate.
  const countsPackPrice = !isPrimarySelected && packPriceTemplate.trim() !== "";
  const filledCount =
    SLOT_BUILDER_TEXT_FIELDS.filter((f) => localeStrings[f.key]?.trim()).length +
    (!isPrimarySelected && localeStrings[HEADING_TEXT_KEY]?.trim() ? 1 : 0) +
    (countsDescription && localeStrings[DESCRIPTION_TEXT_KEY]?.trim() ? 1 : 0) +
    (countsPackPrice && localeStrings[PACK_PRICE_TEXT_KEY]?.trim() ? 1 : 0) +
    (countsSubtext && localeStrings[ITEM_SUBTEXT_TEXT_KEY]?.trim() ? 1 : 0);
  const totalCount =
    SLOT_BUILDER_TEXT_FIELDS.length +
    (isPrimarySelected ? 0 : 1) +
    (countsDescription ? 1 : 0) +
    (countsPackPrice ? 1 : 0) +
    (countsSubtext ? 1 : 0);

  return (
    <BlockStack gap="500">
      <SectionHeading />

      <InlineStack gap="300" blockAlign="end" wrap>
        <div style={{ minWidth: 240 }}>
          <Select
            label="Language"
            options={locales.map((l) => ({
              // Unpublished languages are offered so copy can be written
              // before the language goes live in Shopify — labelled so it's
              // clear no shopper is seeing it yet.
              label: l.primary
                ? `${l.name} (default)`
                : l.published
                  ? l.name
                  : `${l.name} — not published`,
              value: l.locale,
            }))}
            value={selectedLocale}
            onChange={setActiveLocale}
            helpText={
              isPrimarySelected
                ? "Your store's default language. This copy is what shoppers see unless another language below overrides it — leave a field blank to use the app's built-in English."
                : primaryLocale
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

      {!isPrimarySelected && (
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          Heading, description &amp; package price
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
              : "Set a heading in Storefront before translating it."
          }
        />
        <TextField
          label="Description"
          value={localeStrings[DESCRIPTION_TEXT_KEY] ?? ""}
          onChange={(value) => setString(DESCRIPTION_TEXT_KEY, value)}
          placeholder={widgetDescription || "Not set"}
          autoComplete="off"
          multiline={2}
          disabled={!widgetDescription.trim()}
          helpText={
            widgetDescription.trim()
              ? undefined
              : "Set a description in Storefront before translating it."
          }
        />
        {/* Only worth translating once the merchant has written their own
            template — the built-in default is pure shortcodes, so it renders
            the same money in every language and has no words to translate. */}
        <TextField
          label="Package tab price"
          value={localeStrings[PACK_PRICE_TEXT_KEY] ?? ""}
          onChange={(value) => setString(PACK_PRICE_TEXT_KEY, value)}
          placeholder={packPriceTemplate || "Not set"}
          autoComplete="off"
          disabled={!packPriceTemplate.trim()}
          helpText={
            packPriceTemplate.trim()
              ? "Keep the shortcodes — only the words around them need translating."
              : "Set a price line in Storefront before translating it."
          }
        />
      </BlockStack>
      )}

      {!isPrimarySelected && (
        <>
          <Divider />
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Product details
            </Text>
            {/* Only the words around the placeholders are translated here —
                what {{sku}} and friends resolve to is catalog data, so a
                metafield that needs translating is translated in Shopify's
                Translate & Adapt, not in this app. */}
            <TextField
              label="Item subtext"
              value={localeStrings[ITEM_SUBTEXT_TEXT_KEY] ?? ""}
              onChange={(value) => setString(ITEM_SUBTEXT_TEXT_KEY, value)}
              placeholder={itemSubtextTemplate || "Not set"}
              autoComplete="off"
              disabled={!itemSubtextTemplate.trim()}
              helpText={
                itemSubtextTemplate.trim()
                  ? "Keep the {{…}} placeholders — only the text around them changes per language. Resolved for every product when you save, so republish after editing it."
                  : "Set an item subtext in Storefront before translating it."
              }
            />
          </BlockStack>
        </>
      )}

      {!isPrimarySelected && packages.length > 0 && (
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
                /* Every other key falls back to the app's own English, so
                   the default is the honest placeholder. `pricePerUnit` has
                   none: what a blank field falls back to is whatever the
                   merchant wrote in Storefront. */
                placeholder={
                  field.key === PRICE_PER_UNIT_TEXT_KEY
                    ? pricePerUnitTemplate || "Not set — the line is hidden"
                    : SLOT_BUILDER_TEXT_DEFAULTS[field.key]
                }
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
