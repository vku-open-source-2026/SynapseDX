// SPDX-License-Identifier: Apache-2.0
// Authoring/renderer verification against the real portable source bundles.
// APIs are fixtures: this does not claim production business-write parity.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { actionGovernanceErrors } from "../../src/lib/studioActions.ts";
import { parsePluginBundle, toWriteWidget } from "../../src/lib/workspaces.ts";
const root = new URL("../../../../../", import.meta.url);
const sources = ["SynapseCity", "SynapseCitySOS"].flatMap(repository => {
  const directory = new URL(repository + "/plugins/", root);
  return fs.readdirSync(directory).filter(file => file.endsWith(".plugin.json")).sort().map(file => JSON.parse(fs.readFileSync(new URL(file, directory), "utf8")));
});
const stamp = "2026-11-15T00:00:00Z";
const installed = sources.map(({ plugin, checksum }) => ({
  ...plugin, id: plugin.slug, version: 6, publishedVersion: 6, status: "published", installed: true,
  createdAt: stamp, updatedAt: stamp, publishedAt: stamp, checksum,
  widgets: plugin.widgets.map(widget => {
    const { workflowRef, ...base } = widget;
    return { ...base, ...(workflowRef ? { workflowArtifactId: "fixture-artifact", workflowArtifactRevision: 1, workflowArtifactChecksum: "sha256:" + "a".repeat(64) } : {}), ...(widget.type === "form" ? { canSubmit: true } : {}) };
  }),
}));
for (const source of sources) {
  test(`source bundle builds in Studio and renders declared sections: ${source.plugin.slug}`, async ({ page }) => {
    test.setTimeout(60_000);
    expect(parsePluginBundle(source).ok).toBe(true);
    expect(actionGovernanceErrors(source.plugin.widgets)).toEqual([]);
    const plugin = installed.find(item => item.slug === source.plugin.slug), reads = new Set(), errors = [], writes = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("synapsedx.console.session.v1", JSON.stringify({ accessToken: "fixture", refreshToken: "fixture-refresh", obtainedAt: "2026-11-15" }));
      localStorage.setItem("synapsedx.lang", "en");
    });
    await page.route("**/v1/capabilities/**", async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      let json = { items: [], total: 0 };
      if (path.endsWith("/management/context")) json = { user: { id: "fixture-admin", email: "fixture@example.com" }, isOrganizationAdmin: true, roles: ["admin"], permissions: ["summary:read", "datasets:read"], tenant: "fixture-org" };
      else if (path.endsWith("/workspaces/access")) json = { products: ["city", "sos"], productRoles: { city: ["admin", "manager", "technician", "volunteer"], sos: ["admin", "manager", "operator", "responder", "volunteer"] }, modules: ["tasks", "projects", "workspace", "inbox", "forms", "reports", "ocr", "assistant"], isOrganizationAdmin: true };
      else if (path.endsWith("/workspaces/catalog")) json = {
        products: ["dx", "city", "sos"].map(product => ({ product, roles: product === "city" ? ["admin", "manager", "technician", "volunteer"] : ["admin", "manager", "operator", "responder", "volunteer"], resources: [...new Set(installed.filter(p => p.product === product).flatMap(p => p.widgets.map(w => w.resource).filter(Boolean)))].map(key => ({ key })), widgetTypes: ["text", "heading", "navigation", "tabs", "metric", "table", "map", "list", "kanban", "timeline", "divider", "form", "action"] })),
        widgetTypes: ["text", "heading", "navigation", "tabs", "metric", "table", "map", "list", "kanban", "timeline", "divider", "form", "action"], mutation: { formExecution: true, formRequiresWorkflowArtifact: true }, limits: {},
      };
      else if (path.endsWith("/workspaces/installed")) json = { items: installed, total: installed.length };
      else if (path.endsWith("/workspaces/plugins")) json = { items: installed.filter(p => p.product === url.searchParams.get("product")).map(p => ({ ...p, widgets: p.widgets.map(toWriteWidget) })) };
      else if (path === `/v1/capabilities/workspaces/plugins/${plugin.id}`) {
        if (request.method() === "PUT") {
          const body = request.postDataJSON();
          const expected = plugin.widgets.map(toWriteWidget);
          expected[0] = { ...expected[0], title: expected[0].title + " audit" };
          expect(body.widgets.map(toWriteWidget)).toEqual(expected);
          expect(actionGovernanceErrors(body.widgets)).toEqual([]);
          writes.push(body);
          json = { ...plugin, ...body, version: 7, status: "draft" };
        } else json = { ...plugin, widgets: plugin.widgets.map(toWriteWidget) };
      }
      else if (/\/widgets\/[^/]+\/data$/.test(path)) {
        const pageId = path.split("/installed/")[1].split("/")[0], id = path.split("/widgets/")[1].split("/")[0];
        const page = installed.find(p => p.id === pageId), widget = page.widgets.find(w => w.id === id);
        expect(url.searchParams.get("action")).toBe(widget.onLoad);
        const operation = page.widgets.find(w => w.id === widget.onLoad).operation;
        expect(operation.source).toBe(widget.resource);
        reads.add(id);
        json = widget.type === "metric" ? { type: "metric", count: 0 } : { type: widget.type, columns: widget.columns, items: [], total: 0, limit: 50, offset: 0 };
      }
      return route.fulfill({ json });
    });
    await page.route("**/health", route => route.fulfill({ json: { status: "ok" } }));
    await page.goto(`/admin/workspaces?product=${plugin.product}&plugin=${plugin.id}`);
    await expect(page.getByRole("heading", { name: plugin.name, level: 2, exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: /Widget title/ }).fill(plugin.widgets[0].title + " audit");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    const sections = [...new Set(plugin.widgets.map(w => w.section).filter(Boolean))];
    for (const section of sections.length ? sections : [undefined]) {
      await page.goto(`/workspace?product=${plugin.product}&page=${plugin.slug}${section ? `&section=${section}` : ""}`);
      await expect(page.getByRole("heading", { name: plugin.name, level: 1, exact: true })).toBeVisible();
      const dataWidgets = plugin.widgets.filter(w => ["table", "metric", "map", "list", "kanban", "timeline", "chart"].includes(w.type) && (!w.section || w.section === section));
      await expect.poll(() => dataWidgets.every(w => reads.has(w.id))).toBe(true);
      await expect(page.getByText("Action unavailable", { exact: true })).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
}
