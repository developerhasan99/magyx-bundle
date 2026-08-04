import { useFetcher } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Page, Layout, Card, BlockStack, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { createBundle, type BundleType } from "../models/bundle.server";
import { BundleTypeCard } from "../components/BundleTypeCard";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

const BUNDLE_TYPE_CHOICES = [
  {
    value: "FIXED",
    label: "Fixed bundle",
    description: "A set combination sold as one product at a set price.",
  },
  {
    value: "SLOT_BUILDER",
    label: "Build a box",
    description:
      "Customers fill a set number of slots from a pool of products, for one flat price.",
  },
  {
    value: "MIX_MATCH",
    label: "Mix & match",
    description:
      "Customers pick any quantity from a list, with tiered discounts as they add more.",
  },
  {
    value: "QUANTITY_BREAKS",
    label: "Quantity breaks",
    description:
      "Reward customers with a bigger discount the more of one product they buy.",
  },
] as const;

// Picking a type creates the draft immediately (rather than deferring to the
// editor's first save) so the merchant lands on /app/bundles/:id right away —
// a mid-edit reload reopens the same draft instead of losing everything on
// the stateless /new route. Defaults mirror the editor's formStateOf()
// fallbacks so the editor opens looking identical to the old "new" screen.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const type = String(formData.get("type") ?? "");
  if (!BUNDLE_TYPE_CHOICES.some((choice) => choice.value === type)) {
    throw new Response("Unknown bundle type", { status: 400 });
  }

  const bundle = await createBundle(session.shop, {
    // Left empty so the editor still forces the merchant to name the bundle
    // before saving; list views render an "Untitled bundle" fallback.
    title: "",
    type: type as BundleType,
    status: "DRAFT",
    pricingType: type === "MIX_MATCH" ? "PERCENT_OFF" : "FIXED_PRICE",
    pricingValue: 0,
    widgetStyle: "numbered",
    widgetHeading: type === "SLOT_BUILDER" ? "" : "What's inside",
    accentColor: "#1a1a1a",
    showPrices: false,
    skipCart: false,
    autoCheckout: false,
    poolMode: "PER_PACKAGE",
    itemSubtextTemplate: "",
    showSubtextOnGifts: true,
    freeShipping: false,
    quantityBreakScope: "PRODUCTS",
    translations: {},
    items: [],
    packages: [],
    tiers: [],
    rule: null,
  });

  return redirect(`/app/bundles/${bundle.id}`);
};

export default function CreateBundle() {
  const fetcher = useFetcher<typeof action>();
  const creating = fetcher.state !== "idle";

  return (
    <Page backAction={{ content: "Home", url: "/app" }} title="Create bundle">
      <TitleBar title="Create bundle" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Choose a bundle type
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  You can&apos;t change this after the bundle is created.
                </Text>
              </BlockStack>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: "var(--p-space-300)",
                  opacity: creating ? 0.6 : 1,
                }}
              >
                {BUNDLE_TYPE_CHOICES.map((option) => (
                  <BundleTypeCard
                    key={option.value}
                    label={option.label}
                    description={option.description}
                    selected={
                      creating && fetcher.formData?.get("type") === option.value
                    }
                    disabled={creating}
                    onSelect={() =>
                      fetcher.submit({ type: option.value }, { method: "POST" })
                    }
                  />
                ))}
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
