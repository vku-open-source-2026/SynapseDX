import { materializeActions } from "../../src/lib/studioActions.ts";
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { test, expect } from "@playwright/test";
const types = [
  "text",
  "metric",
  "table",
  "form",
  "heading",
  "divider",
  "alert",
  "navigation",
  "button",
  "tabs",
  "progress",
  "chart",
  "list",
  "capability",
  "map",
  "kanban",
  "timeline",
  "markdown",
  "code",
  "action",
];
const stamp = "2026-11-15T00:00:00Z";
const readiness = {
  ready: true,
  canSubmit: true,
  installedVersion: "0.9.1",
  minimumVersion: "0.9.1",
  requirement: "Ready",
};
const plugins = ["city", "sos"].map((product) => ({
  id: `${product}-page`,
  product,
  name: product === "city" ? "Infrastructure overview" : "Response overview",
  slug: `${product}-overview`,
  audience: "admin",
  roles: ["admin"],
  version: 1,
  publishedVersion: 1,
  publishedAt: stamp,
  createdAt: stamp,
  updatedAt: stamp,
  status: "published",
  installed: true,
  checksum: "sha256:" + "a".repeat(64),
  widgets: [
    {
      id: "heading",
      type: "heading",
      title: product === "city" ? "A city in motion" : "Ready to respond",
      text: "Your team, connected.",
      width: "full",
    },
    {
      id: "nav",
      type: "navigation",
      title: "Quick access",
      width: "full",
      links: [
        { label: "Team tasks", target: "module:tasks" },
        { label: "Missing page", target: "page:missing-page" },
      ],
    },
    {
      id: "count",
      type: "metric",
      title: product === "city" ? "City assets" : "Active emergency events",
      resource: product === "city" ? "assets" : "events",
      width: "half",
    },
    {
      id: "records",
      type: "table",
      title: "Activity",
      resource: product === "city" ? "assets" : "events",
      columns: ["name", "status"],
      width: "full",
    },
  ],
}));
for (const product of ["city", "sos"])
  plugins.push({
    ...plugins.find((page) => page.product === product),
    id: product + "-common",
    name: "Common workspace",
    slug: product + "-common-workspace",
    widgets: [
      {
        id: "intro",
        type: "heading",
        title: "Common workspace",
        text: product + " team collaboration",
        width: "full",
      },
      {
        id: "tools",
        type: "navigation",
        title: "Your tools",
        links: [
          { label: "Team tasks", target: "module:tasks" },
          { label: "Projects", target: "module:projects" },
        ],
      },
    ],
  });
for (const plugin of plugins)
  plugin.widgets = materializeActions(plugin.widgets);
async function setup(page, admin = true, apps = ["city", "sos"]) {
  const saved = structuredClone(plugins);
  await page.addInitScript(() => {
    localStorage.setItem(
      "synapsedx.console.session.v1",
      JSON.stringify({
        accessToken: "test-token",
        refreshToken: "test-refresh",
        obtainedAt: "2026-11-01",
      }),
    );
    localStorage.setItem("synapsedx.lang", "en");
  });
  await page.route("**/v1/capabilities/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json = { items: [], total: 0 };
    if (path.endsWith("/management/context"))
      json = {
        user: { id: "admin", email: "operator@example.com" },
        isOrganizationAdmin: admin,
        roles: ["admin"],
        permissions: ["summary:read", "datasets:read"],
        tenant: "org:demo",
      };
    else if (path.endsWith("/workspaces/access"))
      json = {
        products: apps,
        productRoles: Object.fromEntries(apps.map((app) => [app, ["admin"]])),
        modules: ["tasks", "projects"],
        isOrganizationAdmin: admin,
      };
    else if (path.endsWith("/workspaces/plugins")) {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        const created = {
          ...body,
          id: "new-plugin",
          version: 1,
          status: "draft",
          createdAt: stamp,
          updatedAt: stamp,
          installed: false,
        };
        saved.push(created);
        return route.fulfill({ status: 201, json: created });
      }
      json = {
        items: saved.filter(
          (plugin) =>
            plugin.product ===
            new URL(route.request().url()).searchParams.get("product"),
        ),
      };
    } else if (/\/workspaces\/plugins\/[^/]+(?:\/publish)?$/.test(path)) {
      const id = path.split("/plugins/")[1].split("/")[0];
      const plugin = saved.find((p) => p.id === id);
      if (!plugin)
        return route.fulfill({
          status: 404,
          json: { error: { message: "Plugin not found" } },
        });
      const body = route.request().postDataJSON();
      if (route.request().method() === "PUT") {
        if ("product" in body)
          return route.fulfill({
            status: 400,
            json: { error: { message: "product is immutable" } },
          });
        if (body.version !== plugin.version)
          return route.fulfill({
            status: 409,
            json: { error: { message: "Version conflict" } },
          });
        Object.assign(plugin, body, {
          version: plugin.version + 1,
          status: "draft",
        });
      } else if (path.endsWith("/publish"))
        Object.assign(plugin, {
          publishedVersion: plugin.version,
          status: "published",
        });
      json = plugin;
    } else if (path.endsWith("/workspaces/installed"))
      json = {
        items: plugins.filter((plugin) => apps.includes(plugin.product)),
        total: plugins.length,
      };
    else if (path.endsWith("/workflow-artifacts/readiness"))
      json = { workflowExecution: readiness, pluginFormsCanSubmit: true };
    else if (path.endsWith("/workspaces/catalog"))
      json = {
        products: ["dx", "city", "sos"].map((product) => ({
          product,
          roles: ["admin", "viewer"],
          resources:
            product === "dx"
              ? []
              : [
                  { key: product === "city" ? "assets" : "events" },
                  ...[
                    "commonWorkspaces",
                    "commonPages",
                    "commonProjects",
                    "commonTasks",
                  ].map((key) => ({ key })),
                ],
          widgetTypes:
            product === "dx"
              ? types.filter(
                  (type) =>
                    !["metric", "table", "form", "chart", "list"].includes(
                      type,
                    ),
                )
              : types.filter((type) => type !== "capability"),
        })),
        widgetTypes: types,
        mutation: {
          formExecution: true,
          formRequiresWorkflowArtifact: true,
          directDatasetWrites: false,
        },
        workflowExecution: readiness,
        limits: {},
      };
    else if (path.includes("/widgets/count/data"))
      json = { widgetId: "count", type: "metric", count: 42 };
    else if (path.includes("/widgets/records/data"))
      json = {
        widgetId: "records",
        type: "table",
        items: [{ name: "Operations team", status: "active" }],
        columns: ["name", "status"],
        total: 1,
      };
    else if (path.endsWith("/projects"))
      json = {
        items: [{ id: "project-1", name: "City improvements" }],
        total: 1,
      };
    else if (path.endsWith("/project-tasks"))
      json = {
        items: [
          {
            id: "task-1",
            projectId: "project-1",
            title: "Review field notes",
            status: "todo",
          },
        ],
        total: 1,
      };
    return route.fulfill({ json });
  });
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
}
test("City and SOS keep separate Common workspace plugins and send the selected app context", async ({
  page,
}) => {
  await setup(page, false);
  await page.goto("/workspace?product=city&page=city-overview");
  await expect(
    page.getByRole("heading", { name: "Infrastructure overview" }),
  ).toBeVisible();
  await expect(page.getByText("42", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Operations team", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Missing page" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(
    0,
  );
  await expect(page.getByText("Edit in Studio")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/dx-city-workspace.png", fullPage: true });
  await page.getByRole("link", { name: "Team tasks" }).click();
  await expect(page).toHaveURL(
    /product=city.*page=city-common-workspace.*module=tasks/,
  );
  await expect(page.getByRole("heading", { name: "Task board" })).toBeVisible();
  await expect(page.getByText("Review field notes")).toBeVisible();
  await page
    .getByRole("button", { name: /SynapseCity Infrastructure/ })
    .click();
  await page
    .getByRole("button", { name: "SynapseCity SOS", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Response overview", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Response overview" }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/dx-sos-workspace.png", fullPage: true });
  const taskRequest = page.waitForRequest((request) =>
    request.url().includes("/project-tasks"),
  );
  await page.getByRole("link", { name: "Team tasks" }).click();
  expect((await taskRequest).headers()["x-workspace-app"]).toBe("sos");
  await expect(page).toHaveURL(
    /product=sos.*page=sos-common-workspace.*module=tasks/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("button", { name: "Common workspace", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/dx-workspace-mobile.png",
    fullPage: true,
  });
});
test("an app admin sees only assigned apps and cannot open Studio", async ({
  page,
}) => {
  await setup(page, false, ["city"]);
  await page.goto("/workspace?product=city&page=city-overview");
  await expect(
    page.getByRole("heading", { name: "Infrastructure overview" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /SynapseCity Infrastructure/ })
    .click();
  await expect(
    page.getByRole("button", { name: "SynapseCity SOS", exact: true }),
  ).toHaveCount(0);
  await page.goto("/workspace?product=sos&page=sos-overview");
  await expect(
    page.getByRole("heading", { name: "App access required" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Response overview" }),
  ).toHaveCount(0);
  await page.goto("/admin/workspaces");
  await expect(page).toHaveURL(/\/workspace/);
  await expect(
    page.getByRole("heading", { name: "Workspace Studio" }),
  ).toHaveCount(0);
  await expect(page.getByText("Edit in Studio")).toHaveCount(0);
});
test("H-D-P-I migration template builds a page with a real drag-and-drop canvas and undo", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto("/admin/workspaces?product=city#template=workspace");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Wiki pages, table" }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: /capability$/ })).toHaveCount(0);
  const heading = page.getByRole("button", { name: "Heading", exact: true });
  const canvas = page.getByRole("group", {
    name: "Your team’s work, connected, heading",
  });
  await heading.dragTo(canvas);
  await expect(
    page.getByRole("group", { name: "New heading, heading" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "New heading, heading" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "New heading, heading" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Duplicate component" }).click();
  await expect(
    page.getByRole("group", { name: "New heading copy, heading" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Mobile preview" }).click();
  await page.getByRole("button", { name: "Desktop preview" }).click();
  await page.screenshot({
    path: "/tmp/dx-workspace-studio.png",
    fullPage: true,
  });
});
test("map and record details preserve geometry, prefill contextual actions and confirm deletes", async ({
  page,
}) => {
  await setup(page, false, ["city"]);
  const record = {
    id: "record-0001",
    name: "Han River bridge",
    status: "active",
    latitude: 16.07,
    longitude: 108.22,
  };
  const widget = {
    id: "locations",
    type: "map",
    title: "Asset locations",
    resource: "assets",
    columns: ["name", "status", "latitude", "longitude"],
    width: "full",
  };
  const fields = [
    { name: "record_id", label: "Record ID", type: "text", required: true },
  ];
  const plugin = {
    ...plugins[0],
    widgets: [
      ...plugins[0].widgets,
      widget,
      {
        id: "edit-record",
        type: "form",
        title: "Edit asset",
        resource: "assets",
        action: "update",
        canSubmit: true,
        workflowArtifactId: "artifact-0001",
        fields: [...fields, { name: "name", label: "Name", type: "text" }],
      },
      {
        id: "delete-record",
        type: "form",
        title: "Delete asset",
        resource: "assets",
        action: "delete",
        canSubmit: true,
        workflowArtifactId: "artifact-0001",
        fields,
      },
    ],
  };
  plugin.widgets = materializeActions(plugin.widgets);
  await page.route("**/workspaces/installed", (route) =>
    route.fulfill({
      json: {
        items: [
          plugin,
          ...plugins.filter((p) => p.slug === "city-common-workspace"),
        ],
        total: 2,
      },
    }),
  );
  await page.route("**/widgets/records/data?*", (route) =>
    route.fulfill({
      json: {
        type: "table",
        items: [record],
        columns: ["name", "status"],
        total: 1,
      },
    }),
  );
  await page.route("**/widgets/locations/data?*", (route) =>
    route.fulfill({
      json: { type: "map", items: [record], columns: widget.columns, total: 1 },
    }),
  );
  await page.route("**/widgets/*/records/record-0001?*", (route) =>
    route.fulfill({
      json: {
        id: record.id,
        data: { ...record, description: "Inspected this morning" },
        version: 3,
      },
    }),
  );
  await page.route("**/geo/tiles/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await page.goto("/workspace?product=city&page=city-overview");
  await expect(
    page.getByLabel("Asset locations interactive map"),
  ).toBeVisible();
  await expect(page.getByText("1 located · 0 without location")).toBeVisible();
  await page.getByRole("button", { name: "Fit all locations" }).click();
  await page.screenshot({ path: "/tmp/dx-business-map.png", fullPage: true });
  await page.getByRole("button", { name: "View Han River bridge" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Inspected this morning")).toBeVisible();
  await page.getByRole("button", { name: "Edit asset", exact: true }).click();
  await expect(page.getByLabel("Record ID")).toHaveValue(record.id);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    record.name,
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "View Han River bridge" }).click();
  await page.getByRole("button", { name: "Delete asset", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Request deletion" }),
  ).toBeDisabled();
  await page.getByRole("checkbox").check();
  await expect(
    page.getByRole("button", { name: "Request deletion" }),
  ).toBeEnabled();
});

for (const product of ["city", "sos"])
  test(`Studio edits and republishes the existing ${product} plugin without changing its app or data binding`, async ({
    page,
  }) => {
    await setup(page);
    const plugin = plugins.find((p) => p.id === `${product}-page`);
    await page.goto(`/admin/workspaces?product=${product}&plugin=${plugin.id}`);
    await expect(
      page.getByRole("heading", { name: plugin.name, exact: true }),
    ).toBeVisible();
    await page.getByRole("group", { name: "Activity, table" }).click();
    await page.getByLabel(/Widget title/).fill("Edited activity");
    const saved = page.waitForRequest(
      (r) => r.method() === "PUT" && r.url().endsWith(`/plugins/${plugin.id}`),
    );
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    const body = (await saved).postDataJSON();
    expect(body).not.toHaveProperty("product");
    expect(body.version).toBe(1);
    expect(body.widgets.find((w) => w.id === "records")).toMatchObject({
      title: "Edited activity",
      resource: product === "city" ? "assets" : "events",
      columns: ["name", "status"],
    });
    await expect(page.getByText("All changes saved")).toBeVisible();
    const published = page.waitForRequest(
      (r) =>
        r.method() === "POST" &&
        r.url().endsWith(`/plugins/${plugin.id}/publish`),
    );
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    expect((await published).postDataJSON()).toEqual({ version: 2 });
    await expect(page.getByText("All changes saved")).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("group", { name: "Edited activity, table" }),
    ).toBeVisible();
  });

test("Code Studio authors HTML CSS JavaScript, runs a preview with logs and saves code in the existing plugin", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto("/admin/workspaces?product=city&plugin=city-page");
  await page.getByRole("button", { name: "Custom code", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Code Studio", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /Code Studio/ });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(
      "Changes apply only to this widget. Then Save draft and Publish.",
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Run preview" }).click();
  const frame = page.frameLocator(
    'iframe[title="New custom code code preview"]',
  );
  await expect(
    frame.getByRole("button", { name: "Clicked 0 times" }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Clicked 0 times" }).click();
  await expect(
    frame.getByRole("button", { name: "Clicked 1 times" }),
  ).toBeVisible();
  await expect(dialog.getByRole("log")).toContainText("Click count 1");
  await dialog.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(dialog.locator("iframe")).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: /Activity.*records/ }).check();
  await dialog.getByRole("tab", { name: "JavaScript", exact: true }).click();
  await dialog
    .locator('[aria-label="javascript source"]')
    .fill(
      'const data = await studio.query("records"); studio.render(`<h2>${data.total} records</h2>`); console.log("bound query", data.total);',
    );
  await dialog.getByRole("tab", { name: "Preview data" }).click();
  await dialog
    .locator('[aria-label="Preview data JSON"]')
    .fill('{"records":{"rows":[{"name":"Sample"}],"total":7}}');
  await dialog.getByRole("button", { name: "Run preview" }).click();
  await expect(frame.getByRole("heading", { name: "7 records" })).toBeVisible();
  await expect(dialog.getByRole("log")).toContainText("bound query 7");
  await page.screenshot({ path: "/tmp/dx-code-studio.png", fullPage: true });
  await dialog.getByRole("button", { name: "Apply code" }).click();
  const saved = page.waitForRequest(
    (r) => r.method() === "PUT" && r.url().endsWith("/plugins/city-page"),
  );
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  const savedWidgets = (await saved).postDataJSON().widgets;
  expect(savedWidgets.filter((w) => w.type !== "code")).toEqual(
    plugins.find((plugin) => plugin.id === "city-page").widgets,
  );
  const widget = savedWidgets.find((w) => w.type === "code");
  expect(widget.code.javascript).toContain('studio.query("records")');
  expect(widget.code.inputs).toEqual(["records"]);
  expect(widget.code.actions).toEqual([]);
  await expect(page.getByText("All changes saved")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("group", { name: "New custom code, code" }),
  ).toBeVisible();
});

test("published custom code uses authorized widget data and confirmed pinned actions without credentials or network", async ({
  page,
}) => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    "This security check requires the production nginx CSP",
  );
  await setup(page, false, ["city"]);
  const code = {
    html: '<script>parent.hacked=true</script><img src="https://example.invalid/leak"><button data-event="delete" onclick="parent.hacked=true">Delete selected asset</button><div id="status"></div>',
    css: "button{padding:12px}",
    javascript: `
console.log("globals", typeof document, typeof localStorage, typeof process);
try { await fetch("https://example.invalid/leak"); console.error("network escaped"); } catch { console.log("network blocked"); }
try { importScripts("/studio-sandbox.js"); console.error("import escaped"); } catch { console.log("imports blocked"); }
try { await studio.query("foreign-widget"); } catch (e) { console.log(e.message); }
const data=await studio.query("records"); console.log("loaded",data.total);
studio.on("delete",async()=>{const result=await studio.action("delete-record",{record_id:"asset-1"});console.log("action",result.accepted);});
studio.render('<button data-event="delete">Delete selected asset</button><p>Ready for action</p>');`,
    inputs: ["records"],
    actions: ["delete-record"],
    height: 220,
  };
  const plugin = {
    ...plugins[0],
    widgets: [
      ...plugins[0].widgets,
      { id: "custom", type: "code", title: "Asset tools", code, width: "full" },
      {
        id: "delete-record",
        type: "form",
        title: "Delete asset",
        resource: "assets",
        action: "delete",
        canSubmit: true,
        workflowArtifactId: "artifact-0001",
        fields: [
          { name: "record_id", label: "ID", type: "text", required: true },
        ],
      },
    ],
  };
  plugin.widgets = materializeActions(plugin.widgets);
  await page.route("**/workspaces/installed", (route) =>
    route.fulfill({ json: { items: [plugin], total: 1 } }),
  );
  let executed = 0;
  await page.route("**/widgets/delete-record/execute?*", (route) => {
    executed++;
    expect(route.request().postDataJSON()).toEqual({
      values: { record_id: "asset-1" },
    });
    return route.fulfill({ json: { accepted: true } });
  });
  const requests = [];
  page.on("request", (r) => {
    if (r.url().includes("example.invalid")) requests.push(r.url());
  });
  await page.goto("/workspace?product=city&page=city-overview");
  const frame = page.frameLocator('iframe[title="Asset tools code preview"]');
  await expect(
    frame.getByRole("button", { name: "Delete selected asset" }),
  ).toBeVisible();
  await expect(frame.getByText("Ready for action")).toBeVisible();
  expect(await page.evaluate(() => window.hacked)).toBeUndefined();
  await expect(frame.locator("#root script,#root img")).toHaveCount(0);
  expect(requests).toEqual([]);
  await expect(page.getByRole("link", { name: "Edit in Studio" })).toHaveCount(
    0,
  );
  await frame.getByRole("button", { name: "Delete selected asset" }).click();
  await expect(
    page.getByRole("dialog", { name: "Confirm Delete asset" }),
  ).toBeVisible();
  expect(executed).toBe(0);
  await expect(
    page.getByRole("button", { name: "Confirm action" }),
  ).toBeDisabled();
  await page.getByRole("checkbox", { name: "I confirm this deletion" }).check();
  await page.getByRole("button", { name: "Confirm action" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(executed).toBe(1);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("synapsedx.console.session.v1"),
    ),
  ).toContain("test-token");
});

test("Code Studio blocks undeclared bindings, reports unavailable globals and stops infinite loops", async ({
  page,
}) => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    "This security check requires the production nginx CSP",
  );
  await setup(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto("/admin/workspaces?product=city&plugin=city-page");
  await page.getByRole("button", { name: "Custom code", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Code Studio", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /Code Studio/ });
  const editor = dialog.locator('[aria-label="javascript source"]');
  await editor.fill(
    'console.log("globals", typeof document, typeof localStorage, typeof process); try { await studio.query("foreign-widget"); } catch (error) { console.log(error.message); } try { await fetch("https://example.invalid"); } catch { console.log("network blocked"); } try { importScripts("/studio-sandbox.js"); } catch { console.log("imports blocked"); }',
  );
  await dialog.getByRole("button", { name: "Run preview" }).click();
  await expect(dialog.getByRole("log")).toContainText(
    "globals undefined undefined undefined",
  );
  await expect(dialog.getByRole("log")).toContainText(
    "This widget binding is not declared",
  );
  await expect(dialog.getByRole("log")).toContainText("network blocked");
  await expect(dialog.getByRole("log")).toContainText("imports blocked");
  await editor.fill("while (true) {}");
  await dialog.getByRole("button", { name: "Run preview" }).click();
  await expect(dialog.getByRole("log")).toContainText(
    "5-second execution limit",
    { timeout: 15000 },
  );
  await dialog.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(dialog.locator("iframe")).toHaveCount(0);
});

test("workflow Studio edits JavaScript node source while preserving graph and saving a revision", async ({
  page,
}) => {
  await setup(page);
  const artifact = {
    id: "artifact-0001",
    workflowId: "workflow-0001",
    name: "Asset business rules",
    revision: 3,
    version: 3,
    active: true,
    protected: true,
    syncState: "ready",
    checksum: "a".repeat(64),
    credentialRedactions: [],
    versionCount: 3,
    nodeCount: 2,
    createdAt: stamp,
    updatedAt: stamp,
    nodes: [
      { name: "Start", type: "n8n-nodes-base.manualTrigger", parameters: {} },
      {
        name: "Rules",
        type: "n8n-nodes-base.code",
        parameters: { code: "return { approved: false };" },
      },
    ],
    connections: {
      Start: { main: [[{ node: "Rules", type: "main", index: 0 }]] },
    },
    settings: { access: { mode: "owner-only" } },
  };
  await page.route("**/workflow-artifacts", (route) =>
    route.fulfill({
      json: {
        items: [artifact],
        total: 1,
        limit: 100,
        offset: 0,
        nextCursor: null,
      },
    }),
  );
  await page.route("**/workflow-artifacts/artifact-0001", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      Object.assign(artifact, body.definition, { version: 4, revision: 4 });
    }
    return route.fulfill({ json: artifact });
  });
  await page.goto("/admin/workflows?artifact=artifact-0001");
  await page.getByRole("tab", { name: "JavaScript nodes" }).click();
  await expect(page.getByLabel("JavaScript workflow node")).toHaveValue(
    "Rules",
  );
  await page
    .locator('[aria-label="Workflow JavaScript source"]')
    .fill("return { approved: $input.amount < 100 };");
  const saved = page.waitForRequest(
    (r) =>
      r.method() === "PUT" &&
      r.url().endsWith("/workflow-artifacts/artifact-0001"),
  );
  await page.getByRole("button", { name: "Save revision" }).click();
  const body = (await saved).postDataJSON();
  expect(body.version).toBe(3);
  expect(body.definition.nodes[1].parameters.code).toContain(
    "$input.amount < 100",
  );
  expect(body.definition.connections).toEqual(artifact.connections);
  expect(body.definition.settings).toEqual(artifact.settings);
  await expect(page.getByText("rev 4", { exact: true })).toBeVisible();
});

test("only a verified organization admin can open the current installed page in Studio", async ({
  page,
}) => {
  await setup(page, true, ["city", "sos"]);
  await page.goto("/workspace?product=sos&page=sos-overview");
  const edit = page.getByRole("link", { name: "Edit in Studio" });
  await expect(edit).toHaveAttribute(
    "href",
    "/admin/workspaces?product=sos&plugin=sos-page",
  );
  await edit.click();
  await expect(page).toHaveURL(
    /\/admin\/workspaces\?product=sos&plugin=sos-page/,
  );
  await expect(
    page.getByRole("heading", { name: "Response overview", exact: true }),
  ).toBeVisible();
});

test("admin sidebar collapses persistently, grows the canvas and keeps the mobile menu usable", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/v1/capabilities/datasets?*", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/admin/workspaces?product=city&plugin=city-page");
  const sidebar = page.locator("#admin-sidebar");
  const canvas = page.getByLabel("Widget design canvas", { exact: true });
  await expect(canvas).toBeVisible();
  const initial = await canvas.boundingBox();
  expect(initial.width).toBeGreaterThan(1000);
  expect(initial.height).toBeGreaterThanOrEqual(640);
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await expect.poll(async () => (await sidebar.boundingBox()).width).toBe(72);
  await expect
    .poll(async () => (await canvas.boundingBox()).width)
    .toBeGreaterThan(initial.width + 180);
  await expect(
    page.getByRole("link", { name: "Workspace Studio", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await expect(
    page.getByRole("button", { name: "Expand sidebar", exact: true }),
  ).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/dx-studio-wide-canvas.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Datasets", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/datasets/);
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Toggle navigation", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Workspace Studio", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox()).width).toBe(264);
  await expect(
    page.getByRole("button", { name: "Expand sidebar", exact: true }),
  ).toBeHidden();
  await page
    .getByRole("link", { name: "Workspace Studio", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Toggle navigation", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page
    .getByRole("button", { name: "Expand sidebar", exact: true })
    .click();
  await expect.poll(async () => (await sidebar.boundingBox()).width).toBe(264);
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
});

test("Studio header creates another plugin, manages actions and wires a button while keeping the canvas central", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.goto("/admin/workspaces?product=city&plugin=city-page");
  const header = page.getByLabel("Studio plugin controls");
  await expect(
    header.getByRole("button", { name: "New plugin", exact: true }),
  ).toBeVisible();
  await expect(header.getByLabel("Choose page")).toHaveValue("city-page");
  await header.getByRole("button", { name: "New plugin", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New workspace plugin" });
  await create.getByLabel("Name", { exact: false }).fill("Action playground");
  await create
    .getByRole("button", { name: "Create draft", exact: true })
    .click();
  await expect(header.getByLabel("Choose page")).toHaveValue("");
  await expect(
    header.getByRole("heading", { name: "Action playground" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("button", { name: "New action", exact: true }).click();
  await page.getByLabel("Action name", { exact: true }).fill("Calculate total");
  await expect(page.getByRole("group", { name: /action$/ })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Open Action Studio", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Action Studio · Calculate total",
  });
  await editor.getByLabel("Action preset").selectOption("function");
  await editor
    .getByLabel("Action function source")
    .fill(
      'async function run(input, studio) { console.log("calculating"); return { total: 7 * 6 }; }',
    );
  await editor
    .getByRole("button", { name: "Run action preview", exact: true })
    .click();
  await expect(editor.getByLabel("Action preview result")).toContainText(
    '"total": 42',
  );
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Components", exact: true }).click();
  await page.getByRole("button", { name: "Button", exact: true }).click();
  await page
    .getByLabel("Widget onClick")
    .selectOption({ label: "Calculate total · function" });
  const savedPromise = page.waitForRequest(
    (req) =>
      new URL(req.url()).pathname.endsWith("/workspaces/plugins") &&
      req.method() === "POST",
  );
  await header.getByRole("button", { name: "Save draft", exact: true }).click();
  const saved = (await savedPromise).postDataJSON();
  expect(
    saved.widgets.find((w) => w.type === "action").operation.javascript,
  ).toContain("7 * 6");
  expect(saved.widgets.find((w) => w.type === "button").onClick).toBe(
    saved.widgets.find((w) => w.type === "action").id,
  );
  await expect(header.getByLabel("Choose page")).toHaveValue("new-plugin");
  await page.screenshot({
    path: "/tmp/dx-actions-studio-header.png",
    fullPage: true,
  });
});

test("Action Studio presets map a field from the selected form and simulate writes in preview", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.goto("/admin/workspaces?product=city&plugin=city-page");
  await page.getByRole("button", { name: "Form", exact: true }).click();
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("button", { name: "New action", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Action Studio", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /Action Studio/ });
  await dialog
    .getByLabel("Action preset", { exact: true })
    .selectOption("create");

  const formId = await dialog.getByLabel("Action target").inputValue();
  await dialog.getByLabel("Input source 1").selectOption("input:" + formId);
  await dialog
    .getByRole("tab", { name: "Preview inputs", exact: true })
    .click();
  await dialog.getByLabel("Action preview inputs").fill(
    JSON.stringify({
      widgets: { [formId]: { notes: "From preview input" } },
      selected: null,
    }),
  );
  await dialog
    .getByRole("button", { name: "Run action preview", exact: true })
    .click();
  await expect(dialog.getByLabel("Action preview result")).toContainText(
    "From preview input",
  );
  await expect(dialog.getByLabel("Action preview result")).toContainText(
    '"preview": true',
  );
  await page.screenshot({
    path: "/tmp/dx-action-preset-editor.png",
    fullPage: true,
  });
});

async function actionRuntimeFixture(page, operation, canSubmit = true) {
  await setup(page, false, ["city"]);
  const form = {
    id: "edit-inputs",
    type: "form",
    title: "Edit inputs",
    resource: "assets",
    action: "update",
    workflowArtifactId: "artifact-0001",
    presentation: "inline",
    canSubmit,
    fields: [
      {
        name: "record_id",
        label: "Record ID",
        type: "text",
        defaultValue: "asset-1",
        required: true,
      },
      {
        name: "status",
        label: "Status input",
        type: "text",
        defaultValue: "active",
      },
    ],
  };
  const plugin = {
    ...plugins[0],
    widgets: [
      form,
      { id: "save-action", type: "action", title: "Save asset", operation },
      {
        id: "save-button",
        type: "button",
        title: "Apply changes",
        onClick: "save-action",
      },
    ],
  };
  plugin.widgets = materializeActions(plugin.widgets);
  await page.route("**/workspaces/installed", (route) =>
    route.fulfill({ json: { items: [plugin], total: 1 } }),
  );
  const calls = [];
  await page.route("**/widgets/edit-inputs/execute?*", (route) => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, status: "done" } });
  });
  await page.goto("/workspace?product=city&page=city-overview");
  return calls;
}
test("a canvas button runs a preset with current input values and requires confirmation before writing", async ({
  page,
}) => {
  const calls = await actionRuntimeFixture(page, {
    kind: "update",
    target: "edit-inputs",
    mappings: [
      {
        field: "record_id",
        source: "input",
        widgetId: "edit-inputs",
        value: "record_id",
      },
      {
        field: "status",
        source: "input",
        widgetId: "edit-inputs",
        value: "status",
      },
    ],
    javascript: "",
    inputs: [],
    actions: [],
  });
  await page.getByLabel("Status input", { exact: false }).fill("done");
  await page
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  const confirm = page.getByRole("dialog", { name: "Confirm Edit inputs" });
  await expect(confirm).toBeVisible();
  expect(calls).toHaveLength(0);
  await expect(confirm).toContainText('"status": "done"');
  await confirm
    .getByRole("button", { name: "Confirm action", exact: true })
    .click();
  await expect(page.getByLabel("Action result")).toContainText('"ok": true');
  expect(calls).toEqual([{ values: { record_id: "asset-1", status: "done" } }]);
});
test("button functions receive page inputs, return results and cannot invoke an undeclared form", async ({
  page,
}) => {
  const calls = await actionRuntimeFixture(page, {
    kind: "function",
    mappings: [],
    javascript:
      'async function run(input, studio) { return {status: input.widgets["edit-inputs"].status, isolated: typeof document}; }',
    inputs: [],
    actions: [],
  });
  await page.getByLabel("Status input", { exact: false }).fill("ready");
  await page
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(page.getByLabel("Action result")).toContainText(
    '"status": "ready"',
  );
  await expect(page.getByLabel("Action result")).toContainText(
    '"isolated": "undefined"',
  );
  expect(calls).toHaveLength(0);
  await actionRuntimeFixture(page, {
    kind: "function",
    mappings: [],
    javascript:
      'async function run(input, studio) { return await studio.action("edit-inputs", {status:"done"}); }',
    inputs: [],
    actions: [],
  });
  await page
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "binding is not declared",
  );
  expect(calls).toHaveLength(0);
});
test("a preset cannot submit a form the installed member is not authorized to use", async ({
  page,
}) => {
  const calls = await actionRuntimeFixture(
    page,
    {
      kind: "update",
      target: "edit-inputs",
      mappings: [
        { field: "record_id", source: "literal", value: "asset-1" },
        { field: "status", source: "literal", value: "done" },
      ],
      javascript: "",
      inputs: [],
      actions: [],
    },
    false,
  );
  await page
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "unavailable for your role",
  );
  await expect(
    page.getByRole("button", { name: "Confirm action", exact: true }),
  ).toHaveCount(0);
  expect(calls).toHaveLength(0);
});

test("unassigned declarative data widgets cannot perform hidden reads", async ({
  page,
}) => {
  await setup(page, false, ["city"]);
  const plugin = {
    ...plugins[0],
    widgets: [
      {
        id: "unbound",
        type: "table",
        title: "Unbound records",
        resource: "assets",
        columns: ["name"],
      },
    ],
  };
  let calls = 0;
  await page.route("**/workspaces/installed", (route) =>
    route.fulfill({ json: { items: [plugin], total: 1 } }),
  );
  await page.route("**/widgets/unbound/data**", (route) => {
    calls++;
    return route.fulfill({ json: { type: "table", items: [], total: 0 } });
  });
  await page.goto("/workspace?product=city&page=city-overview");
  await expect(page.getByRole("alert")).toContainText(
    "No query action assigned",
  );
  await expect(page.getByRole("textbox", { name: "Search Unbound records" })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText(
    "No query action assigned",
  );
  expect(calls).toBe(0);
});
test("all chart types render through their declared source queries", async ({
  page,
}) => {
  await setup(page, false, ["city"]);
  const kinds = ["bar", "line", "area", "pie", "donut"];
  const plugin = {
    ...plugins[0],
    widgets: materializeActions(
      kinds.map((kind) => ({
        id: "chart-" + kind,
        type: "chart",
        title: kind + " overview",
        resource: "assets",
        columns: ["region", "amount"],
        chartType: kind,
        aggregation: "sum",
        width: "half",
      })),
    ),
  };
  const reads = [];
  await page.route("**/workspaces/installed", (route) =>
    route.fulfill({ json: { items: [plugin], total: 1 } }),
  );
  await page.route("**/widgets/chart-*/data**", (route) => {
    const url = new URL(route.request().url()),
      id = url.pathname.split("/widgets/")[1].split("/")[0];
    reads.push({ id, action: url.searchParams.get("action") });
    return route.fulfill({
      json: {
        type: "chart",
        items: [
          { region: "North", amount: 12 },
          { region: "South", amount: 8 },
        ],
        columns: ["region", "amount"],
        total: 2,
      },
    });
  });
  await page.goto("/workspace?product=city&page=city-overview");
  for (const kind of kinds)
    await expect(
      page.getByRole("img", { name: `${kind} overview · ${kind} chart` }),
    ).toBeVisible();
  expect(reads).toHaveLength(5);
  for (const read of reads) expect(read.action).toBe(`act-${read.id}-load`);
  await page.screenshot({
    path: "/tmp/dx-governed-charts.png",
    fullPage: true,
  });
});
test("read-only query functions transform only declared widget sources", async ({
  page,
}) => {
  await setup(page, false, ["city"]);
  const plugin = {
    ...plugins[0],
    widgets: [
      {
        id: "records",
        type: "table",
        title: "Filtered assets",
        resource: "assets",
        columns: ["name", "status"],
        onLoad: "filtered-query",
      },
      {
        id: "filtered-query",
        type: "action",
        title: "Filter operational assets",
        operation: {
          kind: "function",
          mappings: [],
          inputs: ["records"],
          actions: [],
          javascript:
            'async function run(input, studio) { const data=await studio.query("records", {limit:50}); const rows=data.rows.filter(row=>row.status==="active"); return {...data, rows, total:rows.length}; }',
        },
      },
    ],
  };
  const reads = [];
  await page.route("**/workspaces/installed", (route) =>
    route.fulfill({ json: { items: [plugin], total: 1 } }),
  );
  await page.route("**/widgets/records/data**", (route) => {
    reads.push(new URL(route.request().url()).searchParams.get("action"));
    return route.fulfill({
      json: {
        type: "table",
        items: [
          { id: "a", name: "Working lamp", status: "active" },
          { id: "b", name: "Retired lamp", status: "inactive" },
        ],
        columns: ["name", "status"],
        total: 2,
      },
    });
  });
  await page.goto("/workspace?product=city&page=city-overview");
  await expect(
    page.getByRole("button", { name: "Working lamp", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Retired lamp", { exact: true })).toHaveCount(0);
  expect(reads).toEqual(["filtered-query"]);
});

test("native action sequences update inputs and branch using the new values before a confirmed write", async ({
  page,
}) => {
  await setup(page, false, ["city"]);
  const preset = (kind, extra = {}) => ({
    kind,
    mappings: [],
    javascript: "",
    inputs: [],
    actions: [],
    ...extra,
  });
  const widgets = materializeActions([
    {
      id: "edit-inputs",
      type: "form",
      title: "Edit inputs",
      resource: "assets",
      action: "update",
      presentation: "inline",
      canSubmit: true,
      workflowArtifactId: "artifact-0001",
      fields: [
        {
          name: "record_id",
          label: "Record id",
          type: "text",
          defaultValue: "asset-1",
        },
        {
          name: "status",
          label: "Status input",
          type: "text",
          defaultValue: "active",
        },
      ],
    },
    {
      id: "set-status",
      type: "action",
      title: "Set completed",
      operation: preset("setValues", {
        target: "edit-inputs",
        mappings: [{ field: "status", source: "literal", value: "done" }],
      }),
    },
    {
      id: "check-status",
      type: "action",
      title: "If complete",
      operation: preset("condition", {
        comparison: "equals",
        compareValue: "done",
        then: "write-status",
        mappings: [
          {
            field: "value",
            source: "input",
            widgetId: "edit-inputs",
            value: "status",
          },
        ],
      }),
    },
    {
      id: "write-status",
      type: "action",
      title: "Write status",
      operation: preset("update", {
        target: "edit-inputs",
        mappings: [
          {
            field: "record_id",
            source: "input",
            widgetId: "edit-inputs",
            value: "record_id",
          },
          {
            field: "status",
            source: "input",
            widgetId: "edit-inputs",
            value: "status",
          },
        ],
      }),
    },
    {
      id: "complete-sequence",
      type: "action",
      title: "Complete sequence",
      operation: preset("sequence", { steps: ["set-status", "check-status"] }),
    },
    {
      id: "complete-button",
      type: "button",
      title: "Complete asset",
      onClick: "complete-sequence",
    },
  ]);
  const plugin = { ...plugins[0], widgets },
    calls = [];
  await page.route("**/workspaces/installed", (route) =>
    route.fulfill({ json: { items: [plugin], total: 1 } }),
  );
  await page.route("**/widgets/edit-inputs/execute?*", (route) => {
    calls.push({
      action: new URL(route.request().url()).searchParams.get("action"),
      ...route.request().postDataJSON(),
    });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/workspace?product=city&page=city-overview");
  await page
    .getByRole("button", { name: "Complete asset", exact: true })
    .click();
  const confirm = page.getByRole("dialog", { name: "Confirm Edit inputs" });
  await expect(confirm).toContainText('"status": "done"');
  expect(calls).toHaveLength(0);
  await confirm
    .getByRole("button", { name: "Confirm action", exact: true })
    .click();
  await expect(page.getByLabel("Action result")).toContainText('"ok": true');
  expect(calls).toEqual([
    {
      action: "write-status",
      values: { record_id: "asset-1", status: "done" },
    },
  ]);
});

test("query pagination honors a preset page size and record details use the clicked widget", async ({ page }) => {
  await setup(page, false, ["city"]);
  const widgets = materializeActions(["first", "second"].map(id => ({
    id, type: "table", title: id + " records", resource: "assets", columns: ["name"], width: "full",
  })));
  for (const id of ["first", "second"]) {
    const table = widgets.find(w => w.id === id);
    const query = widgets.find(w => w.id === table.onLoad).operation;
    query.mappings.find(m => m.field === "limit").source = "literal";
    query.mappings.find(m => m.field === "limit").value = "25";
  }
  const plugin = { ...plugins[0], widgets }, reads = [], details = [];
  await page.route("**/workspaces/installed", route => route.fulfill({ json: { items: [plugin], total: 1 } }));
  await page.route("**/widgets/*/data?*", route => {
    const url = new URL(route.request().url()), id = url.pathname.split("/widgets/")[1].split("/")[0];
    const offset = Number(url.searchParams.get("offset") || 0);
    reads.push({ id, offset, limit: Number(url.searchParams.get("limit")) });
    return route.fulfill({ json: { type: "table", columns: ["name"], items: Array.from({ length: Math.min(25, 60 - offset) }, (_, i) => ({ id: `${id}-${i + offset}`, name: `${id} item ${i + offset}` })), total: 60, limit: 25, offset } });
  });
  await page.route("**/widgets/*/records/*?*", route => {
    const url = new URL(route.request().url());
    details.push({ widget: url.pathname.split("/widgets/")[1].split("/")[0], action: url.searchParams.get("action") });
    return route.fulfill({ json: { data: { description: "Details from second widget" }, version: 1 } });
  });
  await page.goto("/workspace?product=city&page=city-overview");
  await expect(page.getByText("1–25 of 60", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await expect(page.getByText("26–50 of 60", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).last().click();
  await expect(page.getByText("51–60 of 60", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous", exact: true }).last().click();
  await expect(page.getByText("26–50 of 60", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View second item 25", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Details from second widget");
  expect(details).toEqual([{ widget: "second", action: "act-second-row" }]);
  expect(reads.filter(r => r.id === "second").map(r => r.offset)).toContain(25);
  expect(reads.every(r => r.limit === 25)).toBe(true);
  expect(reads.filter(r => r.id === "second").slice(0, 3).map(r => r.offset)).toEqual([0, 25, 50]);
});

test("reference selects execute their declared mappings and refresh when their input changes", async ({ page }) => {
  await setup(page, false, ["city"]);
  const widgets = materializeActions([{
    id: "task-inputs", type: "form", title: "Task inputs", resource: "commonTasks", action: "create", presentation: "inline", canSubmit: true,
    fields: [
      { name: "filter", label: "Project filter", type: "text", defaultValue: "North" },
      { name: "projectId", label: "Choose project", type: "select", optionsResource: "commonProjects", optionsAction: "projects-query" },
    ],
  }, {
    id: "projects-query", type: "action", title: "Filtered projects", operation: {
      kind: "query", target: "task-inputs", source: "commonProjects", javascript: "", inputs: [], actions: [], mappings: [
        { field: "search", source: "input", widgetId: "task-inputs", value: "filter" },
        { field: "limit", source: "literal", value: "25" },
      ],
    },
  }]);
  const plugin = { ...plugins[0], widgets }, calls = [];
  await page.route("**/workspaces/installed", route => route.fulfill({ json: { items: [plugin], total: 1 } }));
  await page.route("**/widgets/task-inputs/options/projectId?*", route => {
    const params = new URL(route.request().url()).searchParams;
    calls.push(Object.fromEntries(params));
    const search = params.get("search");
    return route.fulfill({ json: { items: [{ value: search + "-1", label: search + " project" }], total: 1, limit: 25, offset: 0 } });
  });
  await page.goto("/workspace?product=city&page=city-overview");
  await expect(page.getByRole("option", { name: "North project" })).toHaveCount(1);
  await page.getByRole("textbox", { name: "Project filter" }).fill("South");
  await expect(page.getByRole("option", { name: "South project" })).toHaveCount(1);
  expect(calls).toContainEqual({ action: "projects-query", limit: "25", search: "South" });
  expect(calls.every(call => call.action === "projects-query" && call.limit === "25")).toBe(true);
});
