/* Canonical catalogue of every string the Build a Box storefront widget
   renders. Single source of truth for three consumers:

   - the widget itself (widget-src/magyx-bundle-slot-builder-impl.js imports
     this at build time — see the `--bundle` flag on the build:widget-js
     script), which uses the defaults below whenever the merchant hasn't
     overridden them;
   - the admin translations editor, which renders one field per entry in
     SLOT_BUILDER_TEXT_FIELDS and shows the default as the placeholder;
   - publishSlotBuilderBundleProduct, which bakes the merchant's overrides
     into the product's display metafield.

   Adding a string to the widget means adding it here — never inline. Defaults
   are deliberately byte-identical to what the widget rendered before it was
   localized, so an existing shop's storefront copy doesn't shift on upgrade
   (including the SHOUTY ones, which some are by design: `giftValue` is also
   uppercased by CSS, `giftLocked` isn't).

   Defaults and admin metadata are separate objects rather than one array of
   rich entries so esbuild can tree-shake the admin-only labels out of the
   storefront bundle — it ships on every product page render, and the widget
   only ever needs the defaults. TypeScript keeps them in step: a field whose
   `key` isn't in the defaults below won't compile. */

/* Strings that vary by a number come in `_one`/`_other` pairs rather than
   one string with a plural rule baked in. English needs two forms, Japanese
   needs one, Polish needs three — letting the merchant write the forms their
   own language actually uses sidesteps CLDR entirely, and is what every
   comparable Shopify app does. The widget picks `_one` at exactly 1. */
export const SLOT_BUILDER_TEXT_DEFAULTS = {
  slotEmptyTitle: "Choose a product",
  slotEmptyHint: "Tap to browse the collection",
  slotEmptyAction: "CHOOSE",

  ctaChoose_one: "Choose {count} more",
  ctaChoose_other: "Choose {count} more",
  ctaAdd: "Add to cart",
  ctaAddPriced: "Add to cart — {price}",
  ctaAdding: "Adding…",

  progressChoose_one: "Choose {count} more product",
  progressChoose_other: "Choose {count} more products",
  progressComplete: "{count} of {total} selected",
  priceSave: "Save {percent}%",
  pricePerUnit: "That's only {amount} per item.",

  modalTitleReady: "Your bundle is ready!",
  modalTitle_one: "Add {count} more product",
  modalTitle_other: "Add {count} more products",
  modalSubtitle: "Build your {count}-product bundle.",
  searchPlaceholder: "Search products…",
  filterAll: "All",
  emptyPool: "No products available for this option right now.",
  emptySearch: "No products match your search.",
  emptyFilter: "No products match this filter.",

  giftsHeading: "Free Gifts",
  giftFreeShipping: "Free Shipping",
  giftValue: "{amount} VALUE",
  giftLocked: "LOCKED",
  giftExclusive: "{pack} Exclusive",

  errorIncomplete_one: "Choose {count} more product before adding to cart.",
  errorIncomplete_other: "Choose {count} more products before adding to cart.",
  errorAddFailed: "Sorry, we couldn't add this to your cart. Please try again.",

  lineItemProperty: "Item {index}",

  close: "Close",
  a11yAddOne: "Add one {title}",
  a11yRemoveOne: "Remove one {title}",
  a11yRemove: "Remove {title}",
} satisfies Record<string, string>;

/** Storage keys for widget copy. Never rename one — merchant overrides are
    keyed by it, and a rename silently drops their translation. */
export type SlotBuilderTextKey = keyof typeof SLOT_BUILDER_TEXT_DEFAULTS;

/** Reserved key holding per-locale versions of the bundle's `widgetHeading`.
    Not in the defaults above: its fallback is the merchant's own heading, not
    a built-in string, so the widget resolves it slightly differently. */
export const HEADING_TEXT_KEY = "heading";

/** Reserved key holding per-locale versions of the bundle's
    `itemSubtextTemplate`. Unlike every other key here this one never reaches
    the widget: it's a template ("{{sku}} · {{metafield:custom.material}}"),
    and the server resolves it against each product before publishing, so the
    storefront only ever sees the finished line. See resolveSubtextTemplate. */
export const ITEM_SUBTEXT_TEXT_KEY = "itemSubtext";

/** The subtext template to use for one locale: the merchant's override for
    that language if they wrote one, else the bundle's own (primary-language)
    template. Same tag-then-language chain as buildTranslator. */
export function resolveSubtextTemplate(
  translations: SlotBuilderTranslations | undefined,
  primaryLocale: string | null | undefined,
  locale: string | null | undefined,
  fallback: string,
): string {
  for (const tag of [...localeChain(locale), ...localeChain(primaryLocale)]) {
    const value = translations?.[tag]?.[ITEM_SUBTEXT_TEXT_KEY];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

export interface SlotBuilderTextField {
  key: SlotBuilderTextKey;
  /** Section this field is grouped under in the admin editor. */
  group: string;
  /** Admin-facing field label. */
  label: string;
  /** Admin-facing hint, e.g. what a placeholder resolves to. */
  help?: string;
}

/** Placeholders the widget substitutes at render time, for admin help text. */
export const SLOT_BUILDER_TEXT_PLACEHOLDERS = [
  "{count}",
  "{total}",
  "{percent}",
  "{amount}",
  "{price}",
  "{title}",
  "{pack}",
  "{index}",
] as const;

/** Admin-editor metadata, in render order. Tree-shaken out of the widget. */
export const SLOT_BUILDER_TEXT_FIELDS: SlotBuilderTextField[] = [
  {
    key: "slotEmptyTitle",
    group: "Empty slots",
    label: "Empty slot title",
    help: "Each unfilled slot renders as a numbered row that opens the product picker.",
  },
  { key: "slotEmptyHint", group: "Empty slots", label: "Empty slot hint" },
  {
    key: "slotEmptyAction",
    group: "Empty slots",
    label: "Empty slot action",
    help: "The call-to-action at the right of the row. Keep it short.",
  },

  {
    key: "ctaChoose_one",
    group: "Buttons",
    label: "Add to cart — 1 slot left",
    help: "Shown on the disabled add-to-cart button while the box is incomplete.",
  },
  { key: "ctaChoose_other", group: "Buttons", label: "Add to cart — 2+ slots left" },
  {
    key: "ctaAdd",
    group: "Buttons",
    label: "Add to cart",
    help: "Used when the package has no price to show.",
  },
  { key: "ctaAddPriced", group: "Buttons", label: "Add to cart with price" },
  {
    key: "ctaAdding",
    group: "Buttons",
    label: "Adding to cart",
    help: "Shown while the add-to-cart request is in flight.",
  },

  { key: "progressChoose_one", group: "Progress", label: "Slots remaining — 1 left" },
  { key: "progressChoose_other", group: "Progress", label: "Slots remaining — 2+ left" },
  { key: "progressComplete", group: "Progress", label: "All slots filled" },
  {
    key: "priceSave",
    group: "Progress",
    label: "Savings",
    help: "{percent} is how much cheaper the bundle is than buying separately. Use {amount} instead to show the money saved.",
  },
  { key: "pricePerUnit", group: "Progress", label: "Price per item" },

  { key: "modalTitleReady", group: "Selection panel", label: "Panel title — box complete" },
  { key: "modalTitle_one", group: "Selection panel", label: "Panel title — 1 slot left" },
  { key: "modalTitle_other", group: "Selection panel", label: "Panel title — 2+ slots left" },
  {
    key: "modalSubtitle",
    group: "Selection panel",
    label: "Panel subtitle",
    help: "{count} is the package's total slot count, not the number remaining.",
  },
  { key: "searchPlaceholder", group: "Selection panel", label: "Search placeholder" },
  {
    key: "filterAll",
    group: "Selection panel",
    label: "“All” filter chip",
    help: "The automatic chip shown alongside your own category filters.",
  },
  { key: "emptyPool", group: "Selection panel", label: "No products in pool" },
  { key: "emptySearch", group: "Selection panel", label: "No search results" },
  { key: "emptyFilter", group: "Selection panel", label: "No filter results" },

  { key: "giftsHeading", group: "Free gifts", label: "Gifts heading" },
  {
    key: "giftFreeShipping",
    group: "Free gifts",
    label: "Free shipping gift",
    help: "Title of the virtual gift card shown when a package includes free shipping.",
  },
  { key: "giftValue", group: "Free gifts", label: "Gift value badge" },
  {
    key: "giftExclusive",
    group: "Free gifts",
    label: "Gift locked to a bigger package",
    help: "{pack} is the label of the package that unlocks the gift.",
  },
  {
    key: "giftLocked",
    group: "Free gifts",
    label: "Locked gift — fallback",
    help: "Used in place of the above when the unlocking package has no label.",
  },

  { key: "errorIncomplete_one", group: "Errors", label: "Incomplete box — 1 slot left" },
  { key: "errorIncomplete_other", group: "Errors", label: "Incomplete box — 2+ slots left" },
  { key: "errorAddFailed", group: "Errors", label: "Add to cart failed" },

  {
    key: "lineItemProperty",
    group: "Cart",
    label: "Cart line item label",
    help: "Labels each pick on the cart line, e.g. “Item 1: Vanilla Candle”. Also appears at checkout and in order confirmations — past orders keep whatever label was used when they were placed.",
  },

  {
    key: "close",
    group: "Accessibility",
    label: "Close panel",
    help: "Screen-reader label for the selection panel's close button.",
  },
  { key: "a11yAddOne", group: "Accessibility", label: "Increase quantity" },
  { key: "a11yRemoveOne", group: "Accessibility", label: "Decrease quantity" },
  { key: "a11yRemove", group: "Accessibility", label: "Remove pick" },
];

/** Field groups in the order the admin editor should render them. Derived
    lazily rather than at module scope on purpose: a top-level `.reduce()`
    isn't provably side-effect free, so esbuild would keep SLOT_BUILDER_TEXT_FIELDS
    (and every admin-only label in it) alive in the storefront bundle. */
export function slotBuilderTextGroups(): string[] {
  return SLOT_BUILDER_TEXT_FIELDS.reduce<string[]>(
    (groups, field) => (groups.includes(field.group) ? groups : [...groups, field.group]),
    [],
  );
}

/* Merchant overrides, by locale then key. Only keys the merchant actually
   filled in are stored — a blank field means "fall back", not "render
   nothing", so blanks are dropped rather than persisted as empty strings. */
export type SlotBuilderTranslations = Record<string, Record<string, string>>;

/** Per-package copy overrides, by locale. Parallel to the package's own
    `label`/`badgeText`/`tagFilters`, which stay the default-locale copy. */
export interface PackageTranslation {
  label?: string;
  badgeText?: string;
  /** Chip labels positionally matched to the package's own `tagFilters`. */
  tagFilterLabels?: string[];
}

export type PackageTranslations = Record<string, PackageTranslation>;

/** Tolerant JSON parse for the DB's text columns — a hand-edited or
    half-migrated row should degrade to "no translations", never 500. */
export function parseTranslations<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as T)
      : fallback;
  } catch {
    return fallback;
  }
}

/* Storefront locales are full IETF tags ("fr-CA"), but a merchant who
   translated into "fr" expects that copy to show for every French market.
   Tries the exact tag first, then the bare language subtag. */
export function localeChain(locale: string | null | undefined): string[] {
  const tag = String(locale || "").trim();
  if (!tag) return [];
  const base = tag.split("-")[0];
  return base && base !== tag ? [tag, base] : [tag];
}

/** "Choose {count} more" -> "Choose 3 more". An unknown placeholder is left
    as-is rather than blanked, so a merchant who typos "{cont}" sees the
    mistake in their own copy instead of a silently missing number. */
export function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

export type Translator = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/* Resolution order is the shopper's storefront locale, then the shop's
   primary locale, then this build's own English defaults — each tried as the
   full IETF tag ("pt-BR") before the bare language ("pt"), so translating
   into "pt" covers every Portuguese market without listing them.

   Falling back to the primary locale before the built-in defaults is what
   makes a German-only shop work: the merchant's default copy is German, so
   an unlisted market gets German rather than sudden English.

   Lives here rather than in the widget so the same lookup the storefront
   uses can be exercised in isolation and reused by the admin later. */
export function buildTranslator(
  text: SlotBuilderTranslations | undefined,
  primaryLocale: string | null | undefined,
  locale: string | null | undefined,
): Translator {
  const chain = [...localeChain(locale), ...localeChain(primaryLocale)];
  const buckets = chain
    .map((tag) => text?.[tag])
    .filter((bucket): bucket is Record<string, string> => Boolean(bucket));

  return (key, vars) => {
    for (const bucket of buckets) {
      if (typeof bucket[key] === "string" && bucket[key]) {
        return interpolate(bucket[key], vars);
      }
    }
    const fallback = Object.prototype.hasOwnProperty.call(
      SLOT_BUILDER_TEXT_DEFAULTS,
      key,
    )
      ? SLOT_BUILDER_TEXT_DEFAULTS[key as SlotBuilderTextKey]
      : "";
    return interpolate(fallback, vars);
  };
}

/** Picks a value out of a `{ locale: value }` map using the same chain as
    buildTranslator, falling back to a caller-supplied default. Used for
    Shopify-owned strings the merchant translates in Translate & Adapt rather
    than in this app — product titles on pool items and gift cards. */
export type LocaleValueResolver = (
  byLocale: Record<string, string> | undefined,
  fallback: string,
) => string;

export function buildLocaleValueResolver(
  primaryLocale: string | null | undefined,
  locale: string | null | undefined,
): LocaleValueResolver {
  const chain = [...localeChain(locale), ...localeChain(primaryLocale)];
  return (byLocale, fallback) => {
    if (byLocale) {
      for (const tag of chain) {
        const value = byLocale[tag];
        if (typeof value === "string" && value) return value;
      }
    }
    return fallback;
  };
}

/* ---- Catalog product titles ----------------------------------------------
   Unlike everything above, these strings belong to the merchant's catalog,
   not to this app — they're translated in Shopify's Translate & Adapt and
   read back through the Admin API. The composition rule lives here, beside
   the locale helpers, so the server (which bakes per-locale titles into the
   display metafield) and any future consumer share one definition. */

/** A pool item's or gift's display title: the product name, suffixed with the
    variant name when that variant is a real choice rather than Shopify's
    synthetic single-variant placeholder. */
export function composeProductTitle(productTitle: string, variantTitle: string): string {
  const hasRealVariantTitle = variantTitle && variantTitle !== "Default Title";
  return hasRealVariantTitle ? `${productTitle} — ${variantTitle}` : productTitle;
}

/**
 * Recomposes a title from independently-translated product and variant parts,
 * falling back to the untranslated part for whichever side has no translation
 * (a merchant may well translate product names but leave "50ml" alone).
 *
 * Returns "" when neither part is translated, so callers can tell "same as
 * the untranslated title" from "genuinely translated" and skip storing a
 * duplicate — the metafield this ends up in is size-sensitive.
 */
export function localizedProductTitle(
  parts: { productTitle: string; variantTitle: string },
  translated: { product?: string; variant?: string },
): string {
  if (!translated.product && !translated.variant) return "";
  return composeProductTitle(
    translated.product || parts.productTitle,
    translated.variant || parts.variantTitle,
  );
}

export interface PackageTextResolver {
  /** A package's own translated `label`/`badgeText`, else the fallback. */
  field: (
    translations: PackageTranslations | undefined,
    name: "label" | "badgeText",
    fallback: string,
  ) => string;
  /** A filter chip's translated button text, else the fallback. Chip labels
      are stored positionally against the package's own `tagFilters`, so an
      untranslated chip in the middle is a blank slot that falls through
      rather than shifting its neighbours onto the wrong filter. */
  chip: (
    translations: PackageTranslations | undefined,
    index: number,
    fallback: string,
  ) => string;
}

/** Same resolution chain as buildTranslator, for per-package copy. */
export function buildPackageTextResolver(
  primaryLocale: string | null | undefined,
  locale: string | null | undefined,
): PackageTextResolver {
  const chain = [...localeChain(locale), ...localeChain(primaryLocale)];
  const entriesFor = (translations: PackageTranslations | undefined) =>
    chain
      .map((tag) => translations?.[tag])
      .filter((entry): entry is PackageTranslation => Boolean(entry));

  return {
    field: (translations, name, fallback) => {
      for (const entry of entriesFor(translations)) {
        const value = entry[name];
        if (typeof value === "string" && value) return value;
      }
      return fallback;
    },
    chip: (translations, index, fallback) => {
      for (const entry of entriesFor(translations)) {
        const value = entry.tagFilterLabels?.[index];
        if (typeof value === "string" && value) return value;
      }
      return fallback;
    },
  };
}
