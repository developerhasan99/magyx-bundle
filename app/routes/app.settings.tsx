import type { LoaderFunctionArgs } from "@remix-run/node";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  List,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Settings() {
  return (
    <Page>
      <TitleBar title="Settings" />
      <BlockStack gap="500">
        <Layout>
          <Layout.AnnotatedSection
            title="Storefront setup"
            description="How to make bundles visible to your customers."
          >
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Checklist
                </Text>
                <List type="number">
                  <List.Item>
                    Create a bundle and set its status to <strong>Active</strong>.
                  </List.Item>
                  <List.Item>
                    <strong>Fixed bundles</strong> appear as regular products in
                    your store — add them to collections and menus like any
                    other product.
                  </List.Item>
                  <List.Item>
                    <strong>Mix &amp; match bundles</strong> use the Magyx Bundle
                    app block: open your theme editor, add the block to a page,
                    and pick the bundle to display.
                  </List.Item>
                </List>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="Checkout pricing"
            description="Bundle discounts are applied by a Shopify Function at checkout."
          >
            <Card>
              <BlockStack gap="300">
                <Banner tone="info">
                  Bundle pricing is enforced server-side by Shopify — customers
                  can't tamper with discounts, and bundles work with all payment
                  methods and sales channels.
                </Banner>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Deploy the app (<code>npm run deploy</code>) to install the
                  Cart Transform function on your store. This happens
                  automatically when you release a new app version.
                </Text>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>
      </BlockStack>
    </Page>
  );
}
