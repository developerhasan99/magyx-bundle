import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  BlockStack,
  InlineGrid,
  Badge,
  IndexTable,
  IndexFilters,
  useSetIndexFiltersMode,
  useIndexResourceState,
  EmptyState,
  type IndexFiltersProps,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  deleteBundle,
  getBundles,
  setBundleStatus,
  type BundleStatus,
} from "../models/bundle.server";
import { syncBundleConfigMetafield } from "../models/shopify-sync.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  let ownerFirstName: string | null = null;
  try {
    const response = await admin.graphql(`#graphql
      query shopOwner { shop { shopOwnerName } }`);
    const ownerName = (await response.json()).data?.shop?.shopOwnerName;
    ownerFirstName = ownerName?.split(" ")[0] ?? null;
  } catch (error) {
    console.warn("Magyx Bundle: could not load shop owner name", error);
  }

  const bundles = await getBundles(session.shop);
  return {
    ownerFirstName,
    bundles: bundles.map((b) => ({
      id: b.id,
      title: b.title,
      type: b.type,
      status: b.status,
      itemCount: b.items.length,
      updatedAt: b.updatedAt,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const ids = JSON.parse(String(formData.get("ids") ?? "[]")) as string[];

  if (intent === "delete") {
    for (const id of ids) await deleteBundle(session.shop, id);
  } else if (intent === "activate" || intent === "deactivate") {
    const status: BundleStatus = intent === "activate" ? "ACTIVE" : "DRAFT";
    for (const id of ids) await setBundleStatus(session.shop, id, status);
  }

  await syncBundleConfigMetafield(admin, session.shop);
  return { done: intent };
};

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="span" variant="bodyMd" tone="subdued">
          {label}
        </Text>
        <Text as="p" variant="headingLg">
          {value}
        </Text>
      </BlockStack>
    </Card>
  );
}

const typeLabel: Record<string, string> = {
  FIXED: "Fixed",
  SLOT_BUILDER: "Bundle builder",
  MIX_MATCH: "Mix & match",
};

const typeTone: Record<string, "info" | "attention" | "magic"> = {
  FIXED: "info",
  SLOT_BUILDER: "attention",
  MIX_MATCH: "magic",
};

export default function Dashboard() {
  const { bundles, ownerFirstName } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const total = bundles.length;
  const active = bundles.filter((b) => b.status === "ACTIVE").length;
  const drafts = bundles.filter((b) => b.status === "DRAFT").length;

  const [queryValue, setQueryValue] = useState("");
  const [selectedTab, setSelectedTab] = useState(0);
  const { mode, setMode } = useSetIndexFiltersMode();

  const tabs: IndexFiltersProps["tabs"] = [
    { content: "All", id: "all" },
    { content: "Active", id: "active" },
    { content: "Draft", id: "draft" },
  ].map((tab, index) => ({ ...tab, index, onAction: () => setSelectedTab(index) }));

  const filtered = bundles.filter((b) => {
    if (selectedTab === 1 && b.status !== "ACTIVE") return false;
    if (selectedTab === 2 && b.status !== "DRAFT") return false;
    if (queryValue && !b.title.toLowerCase().includes(queryValue.toLowerCase()))
      return false;
    return true;
  });

  const resourceState = useIndexResourceState(filtered);
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    resourceState;

  const runBulk = useCallback(
    (intent: string) => {
      fetcher.submit(
        { intent, ids: JSON.stringify(selectedResources) },
        { method: "POST" },
      );
    },
    [fetcher, selectedResources],
  );

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.done) {
      resourceState.clearSelection();
      const messages: Record<string, string> = {
        activate: "Bundles activated",
        deactivate: "Bundles deactivated",
        delete: "Bundles deleted",
      };
      shopify.toast.show(messages[String(fetcher.data.done)] ?? "Done");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const promotedBulkActions = [
    { content: "Activate", onAction: () => runBulk("activate") },
    { content: "Deactivate", onAction: () => runBulk("deactivate") },
    {
      content: "Delete",
      destructive: true,
      onAction: () => runBulk("delete"),
    },
  ];

  return (
    <Page
      title={ownerFirstName ? `Hi ${ownerFirstName} 👋` : "Hi there 👋"}
      subtitle="Welcome to Magyx Bundle — bundle products together and watch your average order value grow."
      primaryAction={{
        content: "Create bundle",
        url: "/app/bundles/new",
      }}
    >
      <TitleBar title="Magyx Bundle" />
      <BlockStack gap="500">
        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
          <StatCard label="Total bundles" value={String(total)} />
          <StatCard label="Active bundles" value={String(active)} />
          <StatCard label="Drafts" value={String(drafts)} />
        </InlineGrid>

        <Layout>
          <Layout.Section>
            <Card padding="0">
              {total === 0 ? (
                <EmptyState
                  heading="Create bundles to boost your average order value"
                  action={{ content: "Create bundle", url: "/app/bundles/new" }}
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    Combine products into fixed bundles or let customers mix
                    &amp; match their own — discounts apply automatically at
                    checkout.
                  </p>
                </EmptyState>
              ) : (
                <>
                  <IndexFilters
                    queryValue={queryValue}
                    queryPlaceholder="Search bundles"
                    onQueryChange={setQueryValue}
                    onQueryClear={() => setQueryValue("")}
                    tabs={tabs}
                    selected={selectedTab}
                    onSelect={setSelectedTab}
                    filters={[]}
                    onClearAll={() => setQueryValue("")}
                    mode={mode}
                    setMode={setMode}
                    canCreateNewView={false}
                  />
                  <IndexTable
                    itemCount={filtered.length}
                    selectedItemsCount={
                      allResourcesSelected ? "All" : selectedResources.length
                    }
                    onSelectionChange={handleSelectionChange}
                    promotedBulkActions={promotedBulkActions}
                    headings={[
                      { title: "Bundle" },
                      { title: "Type" },
                      { title: "Products" },
                      { title: "Status" },
                      { title: "Last updated" },
                    ]}
                  >
                    {filtered.map((bundle, index) => (
                      <IndexTable.Row
                        id={bundle.id}
                        key={bundle.id}
                        position={index}
                        selected={selectedResources.includes(bundle.id)}
                        onClick={() => navigate(`/app/bundles/${bundle.id}`)}
                      >
                        <IndexTable.Cell>
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {bundle.title}
                          </Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Badge tone={typeTone[bundle.type] ?? "info"}>
                            {typeLabel[bundle.type] ?? bundle.type}
                          </Badge>
                        </IndexTable.Cell>
                        <IndexTable.Cell>{bundle.itemCount}</IndexTable.Cell>
                        <IndexTable.Cell>
                          <Badge
                            tone={bundle.status === "ACTIVE" ? "success" : undefined}
                          >
                            {bundle.status === "ACTIVE" ? "Active" : "Draft"}
                          </Badge>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {new Date(bundle.updatedAt).toLocaleDateString()}
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                </>
              )}
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  How Magyx Bundle works
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  <strong>Fixed bundles</strong> become real products in your
                  store — customers buy them like any product, and inventory is
                  tracked per component.
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  <strong>Bundle builders</strong> are bundle products with
                  numbered slots — customers fill every slot by picking from a
                  pool of products you choose.
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  <strong>Mix &amp; match bundles</strong> let customers build
                  their own box from products you choose, with tiered discounts
                  applied automatically at checkout.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
