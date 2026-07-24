export interface ItemState {
  productId: string;
  variantId: string | null;
  productTitle: string;
  productImageUrl: string | null;
  quantity: number;
  isGift: boolean;
  // Live variant price for display only (combined/compare-at math); not persisted
  price: number | null;
  // True when the referenced variant no longer exists in Shopify
  missing: boolean;
}

export interface CollectionState {
  id: string;
  title: string;
  imageUrl: string | null;
}

export interface TierState {
  quantity: string;
  discount: string;
}

// QUANTITY_BREAKS bundles only: one selectable pack size.
export interface QbTierState {
  // Prisma id once saved; absent for a tier added in this editing session
  id?: string;
  // Stable React key regardless of save state
  tempKey: string;
  quantity: string;
  label: string;
  badgeText: string;
  badgeTone: string; // "" = no badge
  pricingType: string;
  pricingValue: string;
  isDefault: boolean;
  // Free gifts bundled with this pack size — always $0 at checkout
  items: ItemState[];
}

export function defaultQbTiers(): QbTierState[] {
  return [
    {
      tempKey: "new-1",
      quantity: "1",
      label: "1 pack",
      badgeText: "",
      badgeTone: "",
      pricingType: "PERCENT_OFF",
      pricingValue: "0",
      isDefault: false,
      items: [],
    },
    {
      tempKey: "new-2",
      quantity: "2",
      label: "2 pack",
      badgeText: "Save 10%",
      badgeTone: "success",
      pricingType: "PERCENT_OFF",
      pricingValue: "10",
      isDefault: false,
      items: [],
    },
    {
      tempKey: "new-3",
      quantity: "4",
      label: "4 pack",
      badgeText: "Best value",
      badgeTone: "success",
      pricingType: "PERCENT_OFF",
      pricingValue: "20",
      isDefault: true,
      items: [],
    },
  ];
}

// FIXED bundles only: one alternate purchase option ("2 Pack", "3 Pack", ...)
export interface PackageState {
  // Prisma id once saved; absent for a package added in this editing session
  id?: string;
  // Stable React key regardless of save state
  tempKey: string;
  label: string;
  badgeText: string;
  badgeTone: string; // "" = no badge
  pricingType: string;
  pricingValue: string;
  freeShipping: boolean;
  items: ItemState[];
}

export function defaultPackageState(): PackageState {
  return {
    tempKey: "default",
    label: "Default",
    badgeText: "",
    badgeTone: "",
    pricingType: "FIXED_PRICE",
    pricingValue: "",
    freeShipping: false,
    items: [],
  };
}

// QUANTITY_BREAKS only: which products the pack-size tiers apply to.
export const QUANTITY_BREAK_SCOPE_OPTIONS = [
  {
    label: "All products",
    value: "ALL",
    helpText: "Every product in your store gets these pack sizes.",
  },
  {
    label: "A collection",
    value: "COLLECTIONS",
    helpText: "Every product in the chosen collections — stays up to date automatically.",
  },
  {
    label: "Specific products",
    value: "PRODUCTS",
    helpText: "Hand-pick which products this applies to.",
  },
] as const;

export const BADGE_TONE_OPTIONS = [
  { label: "No badge", value: "" },
  { label: "Info", value: "info" },
  { label: "Success", value: "success" },
  { label: "Attention", value: "attention" },
  { label: "Warning", value: "warning" },
  { label: "Critical", value: "critical" },
  { label: "New", value: "new" },
];

export const WIDGET_STYLE_OPTIONS = [
  {
    value: "numbered",
    label: "Numbered",
    description: "Numbered badge on each item, in clean rows.",
  },
  {
    value: "grid",
    label: "Grid",
    description: "Image-forward tiles in a responsive grid.",
  },
  {
    value: "minimal",
    label: "Minimal",
    description: "Compact checklist with small thumbnails.",
  },
] as const;
