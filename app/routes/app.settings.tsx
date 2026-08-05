import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Button,
  Text,
  TextField,
  List,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopSettings, saveCustomCss } from "../models/shop-settings.server";
import { CUSTOM_CSS_MAX_LENGTH } from "../utils/custom-css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return getShopSettings(session.shop);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  try {
    // Returns the sanitized text so the form can show what was actually
    // stored rather than what was typed — otherwise a merchant who pasted
    // markup would see it persist in the field and assume it took effect.
    const customCss = await saveCustomCss(
      admin,
      session.shop,
      String(formData.get("customCss") ?? ""),
    );
    return { saved: true, customCss, error: null };
  } catch (error) {
    return {
      saved: false,
      customCss: null,
      error: error instanceof Error ? error.message : "Couldn't save custom CSS.",
    };
  }
};

export default function Settings() {
  const { customCss: savedCss } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [customCss, setCustomCss] = useState(savedCss);
  const isSaving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.saved) {
      // Adopt the stored value: sanitizing may have changed what the merchant
      // typed, and the field should reflect the truth.
      setCustomCss(fetcher.data.customCss ?? "");
      shopify.toast.show("Custom CSS saved");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const save = useCallback(() => {
    fetcher.submit({ customCss }, { method: "POST" });
  }, [fetcher, customCss]);

  const error = fetcher.data && !fetcher.data.saved ? fetcher.data.error : null;

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
          <Layout.AnnotatedSection
            title="Custom CSS"
            description="Fine-tune how the storefront widget looks, beyond the options in each bundle's Storefront section."
          >
            <Card>
              <BlockStack gap="400">
                {error && (
                  <Banner tone="critical" title="Couldn't save">
                    <p>{error}</p>
                  </Banner>
                )}
                <TextField
                  label="CSS"
                  labelHidden
                  value={customCss}
                  onChange={setCustomCss}
                  multiline={10}
                  autoComplete="off"
                  maxLength={CUSTOM_CSS_MAX_LENGTH}
                  spellCheck={false}
                  placeholder={".magyx-slot-builder__slot { border-radius: 4px; }"}
                  helpText="Applies to every Magyx Bundle widget on your storefront. Loaded after the app's own styles, so a plain rule overrides them without !important."
                />
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Classes you can target
                  </Text>
                  <List>
                    <List.Item>
                      <code>.magyx-slot-builder</code> — Build a box, with{" "}
                      <code>__slot</code>, <code>__slot-number</code>,{" "}
                      <code>__gift-card</code>, <code>__cta</code>
                    </List.Item>
                    <List.Item>
                      <code>.magyx-slot-builder-modal</code> — the product
                      selection panel
                    </List.Item>
                    <List.Item>
                      <code>.magyx-bundle-contents</code> — the fixed bundle
                      &ldquo;what&rsquo;s inside&rdquo; list
                    </List.Item>
                    <List.Item>
                      <code>.magyx-quantity-breaks</code> — the pack-size picker
                    </List.Item>
                  </List>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Accent colour, heading and layout are per bundle — set those
                    in the bundle&rsquo;s Storefront section rather than here.
                  </Text>
                </BlockStack>
                <InlineStack align="end">
                  <Button
                    variant="primary"
                    loading={isSaving}
                    disabled={customCss === savedCss}
                    onClick={save}
                  >
                    Save
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>
      </BlockStack>
    </Page>
  );
}
