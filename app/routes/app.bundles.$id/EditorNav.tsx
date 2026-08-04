import { Card, ActionList } from "@shopify/polaris";

/**
 * The editor used to be one long scroll of cards. These are the chunks it's
 * split into — which ones exist depends on the bundle type, so the nav is
 * derived from `type` rather than hardcoded, and a section id that isn't
 * valid for the current type simply won't appear.
 */
export type EditorSectionId =
  | "general"
  | "products"
  | "gifts"
  | "rules"
  | "tiers"
  | "widget"
  | "appearance"
  | "translations";

export interface EditorSection {
  id: EditorSectionId;
  label: string;
}

/* "General" covers whatever identifies and prices the bundle — the title
   alone for the types without packages, and the title plus package tabs and
   pricing for the two that have them. Deliberately vague for that reason.

   The other labels are per type: "Products" is the bundle's actual contents
   for FIXED, but the pool customers choose *from* for Build a box, and the
   set of products the tiers apply to for Quantity breaks. */
export function editorSectionsFor(type: string): EditorSection[] {
  if (type === "FIXED") {
    return [
      { id: "general", label: "General" },
      { id: "products", label: "Products" },
      { id: "gifts", label: "Free gifts" },
      { id: "appearance", label: "Storefront" },
    ];
  }
  if (type === "SLOT_BUILDER") {
    return [
      { id: "general", label: "General" },
      { id: "products", label: "Product pool" },
      { id: "gifts", label: "Free gifts" },
      { id: "appearance", label: "Storefront" },
      { id: "translations", label: "Translations" },
    ];
  }
  if (type === "QUANTITY_BREAKS") {
    return [
      { id: "general", label: "General" },
      { id: "products", label: "Applies to" },
      { id: "tiers", label: "Pack sizes" },
      { id: "widget", label: "Widget" },
    ];
  }
  return [
    { id: "general", label: "General" },
    { id: "products", label: "Eligible products" },
    { id: "rules", label: "Discount rules" },
  ];
}

/** Sits under the Publishing card in the left column. */
export function EditorNav({
  sections,
  activeSection,
  onSelect,
}: {
  sections: EditorSection[];
  activeSection: EditorSectionId;
  onSelect: (id: EditorSectionId) => void;
}) {
  return (
    <Card padding="200">
      <ActionList
        items={sections.map((section) => ({
          content: section.label,
          active: section.id === activeSection,
          onAction: () => onSelect(section.id),
        }))}
      />
    </Card>
  );
}
