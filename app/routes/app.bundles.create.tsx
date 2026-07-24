import { useNavigate } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { Page, Layout, Card, BlockStack, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
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
    label: "Bundle builder",
    description:
      "A product with numbered slots — customers fill each slot from a pool of products.",
  },
  {
    value: "MIX_MATCH",
    label: "Mix & match",
    description:
      "Customers choose their own items from a list, with tiered discounts.",
  },
  {
    value: "QUANTITY_BREAKS",
    label: "Quantity breaks",
    description:
      "Reward customers with a bigger discount the more of one product they buy.",
    comingSoon: true,
  },
] as const;

export default function CreateBundle() {
  const navigate = useNavigate();

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
                }}
              >
                {BUNDLE_TYPE_CHOICES.map((option) => (
                  <BundleTypeCard
                    key={option.value}
                    label={option.label}
                    description={option.description}
                    selected={false}
                    disabled={"comingSoon" in option && option.comingSoon}
                    badge={"comingSoon" in option && option.comingSoon ? "Coming soon" : undefined}
                    onSelect={() => navigate(`/app/bundles/new?type=${option.value}`)}
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
