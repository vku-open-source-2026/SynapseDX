import { materializeActions } from "../../src/lib/studioActions.ts";
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { test, expect } from "@playwright/test";
import fs from "node:fs";
const widgets = materializeActions(
  JSON.parse(
    fs.readFileSync(
      new URL("../../src/lib/commonTemplate.json", import.meta.url),
      "utf8",
    ),
  ),
);
const stamp = "2026-11-15T00:00:00Z";
async function setup(page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "synapsedx.console.session.v1",
      JSON.stringify({
        accessToken: "test-token",
        refreshToken: "test-refresh",
        obtainedAt: "2026-11-15",
      }),
    );
    localStorage.setItem("synapsedx.lang", "en");
  });
  const plugins = ["city", "sos"].map((product) => ({
    id: product + "-common",
    product,
    name: "Common workspace",
    slug: product + "-common-workspace",
    audience: "member",
    roles: ["volunteer"],
    widgets: widgets.map((widget) => ({
      ...widget,
      ...(widget.type === "form" ? { canSubmit: true } : {}),
    })),
    version: 2,
    publishedVersion: 2,
    publishedAt: stamp,
    checksum: "sha256:" + "a".repeat(64),
  }));
  const tasks = {
    city: [
      {
        id: "task-1",
        title: "Inspect field notes",
        status: "todo",
        assignee: "Team A",
        endDate: "2026-11-20",
        projectId: "project-1",
      },
    ],
    sos: [],
  };
  const submissions = [];
  await page.route("**/v1/capabilities/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    let json = { items: [], total: 0 };
    if (path.endsWith("/management/context"))
      json = {
        user: { id: "member", email: "member@example.com" },
        isOrganizationAdmin: false,
        roles: ["member"],
        permissions: [],
        tenant: "org:demo",
      };
    else if (path.endsWith("/workspaces/access"))
      json = {
        products: ["city", "sos"],
        productRoles: { city: ["volunteer"], sos: ["volunteer"] },
        modules: [
          "tasks",
          "projects",
          "workspace",
          "inbox",
          "forms",
          "reports",
          "ocr",
          "assistant",
        ],
        isOrganizationAdmin: false,
      };
    else if (path.endsWith("/workspaces/installed"))
      json = { items: plugins, total: 2 };
    else if (path.includes("/widgets/")) {
      const match = path.match(
        /installed\/(city|sos)-common\/widgets\/([^/]+)\/(.*)/,
      );
      if (!match)
        return route.fulfill({
          status: 404,
          json: {
            error: { code: "not_found", message: "Unexpected widget route" },
          },
        });
      const [, app, id, operation] = match,
        widget = widgets.find((widget) => widget.id === id);
      if (operation === "data") {
        const rows =
          widget.resource === "commonTasks"
            ? tasks[app]
            : widget.resource === "commonProjects"
              ? [
                  {
                    id: "project-1",
                    name: "City improvements",
                    program: "Roads",
                    startDate: "2026-11-01",
                    endDate: "2026-12-01",
                  },
                ]
              : [];
        json =
          widget.type === "metric"
            ? { type: "metric", count: rows.length }
            : {
                type: widget.type,
                items: rows,
                columns: widget.columns,
                total: rows.length,
              };
      } else if (operation.startsWith("options/"))
        json = { items: [{ value: "project-1", label: "City improvements" }] };
      else if (operation.startsWith("records/"))
        json = {
          data: tasks[app].find((row) => row.id === operation.slice(8)),
          version: 1,
        };
      else if (operation === "execute") {
        const values = request.postDataJSON().values;
        submissions.push({
          app,
          id,
          values,
          header: request.headers()["x-workspace-app"],
        });
        if (id === "task-create") tasks[app].push({ id: "task-2", ...values });
        if (id === "task-status")
          tasks[app].find((row) => row.id === values.record_id).status =
            values.status;
        json = {
          completed: true,
          result:
            id === "assistant-query"
              ? {
                  answer: "# Team answer\nInspection is due this week.",
                  citations: [{ title: "Inspection handbook" }],
                }
              : { ok: true },
        };
      }
    }
    return route.fulfill({ json });
  });
  return { submissions, tasks };
}
test("LCDP Common supports references, task creation, board drag, sections and app separation", async ({
  page,
}) => {
  const { submissions } = await setup(page);
  await page.goto("/workspace?product=city&page=city-common-workspace");
  await expect(
    page.getByRole("heading", { name: "Task board", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Project portfolio" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "New record", exact: true }).click();
  await page.getByLabel("Project", { exact: true }).selectOption("project-1");
  await page.getByLabel("Task title").fill("Field inspection");
  await page.getByLabel("Estimate (hours)").fill("4");
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm action", exact: true })
    .click();
  await expect(page.getByText("Completed successfully.")).toBeVisible();
  expect(submissions[0]).toEqual({
    app: "city",
    id: "task-create",
    values: {
      projectId: "project-1",
      title: "Field inspection",
      status: "todo",
      estimateHours: 4,
    },
    header: "city",
  });
  await page.getByRole("button", { name: "Close dialog" }).click();
  const card = page.locator("article").filter({
    has: page.getByRole("button", { name: "Field inspection", exact: true }),
  });
  await card.dragTo(page.getByRole("region", { name: "doing column" }));
  await page
    .getByRole("button", { name: "Confirm action", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "doing column" })
      .getByRole("button", { name: "Field inspection", exact: true }),
  ).toBeVisible();
  expect(submissions.at(-1)).toEqual({
    app: "city",
    id: "task-status",
    values: { record_id: "task-2", status: "doing" },
    header: "city",
  });
  await page.screenshot({
    path: "/tmp/dx-lcdp-common-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page).toHaveURL(/section=projects/);
  await expect(
    page.getByRole("heading", { name: "Project portfolio", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Task board", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Projects", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.goto(
    "/workspace?product=sos&page=sos-common-workspace&section=tasks",
  );
  await expect(
    page.getByRole("button", { name: "Field inspection", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/tmp/dx-lcdp-common-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("declarative assistant renders an answer and citations without exposing the transport payload", async ({
  page,
}) => {
  await setup(page);
  await page.goto(
    "/workspace?product=city&page=city-common-workspace&section=assistant",
  );
  await page
    .getByLabel("Question", { exact: true })
    .fill("What inspection is due?");
  await page.getByRole("button", { name: "Run action", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm action", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Team answer" }),
  ).toBeVisible();
  await expect(page.getByText("[1] Inspection handbook")).toBeVisible();
  await expect(page.getByText("queryId")).toHaveCount(0);
});

test("native file fields preview CSV and upload/download through explicitly named app actions", async ({ page }) => {
  await setup(page);
  const content = 'name,value\nĐường phố,7\n';
  const seen = [];
  await page.route("**/v1/capabilities/workspaces/installed/*/widgets/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/widgets/file-upload/upload')) {
      expect(url.searchParams.get('action')).toBe('act-file-upload-upload-file-id');
      expect(request.headers()['x-workspace-app']).toBe('city');
      expect(request.postDataBuffer().toString('utf8')).toBe(content);
      seen.push('upload');
      return route.fulfill({ status: 201, json: { id: 'file-1', filename: 'assets.csv', size: Buffer.byteLength(content), contentType: 'text/csv' } });
    }
    if (url.pathname.endsWith('/widgets/files-list/data')) return route.fulfill({ json: { type: 'table', items: [{ id: 'file-1', filename: 'assets.csv', size: Buffer.byteLength(content), contentType: 'text/csv' }], total: 1, columns: ['filename','contentType','size','createdAt'] } });
    if (url.pathname.includes('/widgets/files-list/records/')) return route.fulfill({ json: { data: { id: 'file-1', filename: 'assets.csv' }, version: 1 } });
    if (url.pathname.endsWith('/widgets/files-list/download')) {
      expect(url.searchParams.get('action')).toBe('download-file');
      expect(request.postDataJSON()).toEqual({ values: { file_id: 'file-1' } });
      seen.push('download');
      return route.fulfill({ contentType: 'text/csv', body: content });
    }
    return route.fallback();
  });
  await page.goto('/workspace?product=city&page=city-common-workspace&section=files');
  await page.getByLabel('File', { exact: true }).setInputFiles({ name: 'assets.csv', mimeType: 'text/csv', buffer: Buffer.from(content) });
  await expect(page.getByText('CSV preview · 1 rows')).toBeVisible();
  await page.getByRole('button', { name: 'Upload file', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Uploaded' })).toBeVisible();
  expect(seen).toEqual(['upload']);
  await page.getByRole('button', { name: /assets.csv/ }).first().click();
  await page.keyboard.press('Escape');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download selected file', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('assets.csv');
  expect(seen).toEqual(['upload','download']);
});

for (const interrupted of [false, true]) test(`CSV batch actions ${interrupted ? 'resume after a failed batch' : 'wait for each workflow and aggregate results'}`, async ({ page }) => {
  await setup(page);
  const bundle = JSON.parse(fs.readFileSync(new URL('../../../../../SynapseCity/plugins/city-data-ingest.plugin.json', import.meta.url), 'utf8'));
  const plugin = { ...bundle.plugin, id: 'ingest-page', roles: ['volunteer'], version: 8, publishedVersion: 8, publishedAt: stamp, checksum: bundle.checksum, widgets: bundle.plugin.widgets.map(({ workflowRef, ...widget }) => ({ ...widget, ...(workflowRef ? { workflowArtifactId: 'fixture-artifact', workflowArtifactRevision: 1, workflowArtifactChecksum: 'a'.repeat(64) } : {}), ...(widget.type === 'form' ? { canSubmit: true } : {}) })) };
  const offsets = []; let failed = false, polls = 0;
  await page.route('**/v1/capabilities/workspaces/installed', route => route.fulfill({ json: { items: [plugin] } }));
  await page.route('**/v1/capabilities/workspaces/installed/ingest-page/widgets/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/upload')) return route.fulfill({ status: 201, json: { id: 'csv-file', filename: 'assets.csv' } });
    if (url.pathname.endsWith('/execute')) {
      expect(url.searchParams.get('action')).toBe('import-all-csv-batches');
      const values = request.postDataJSON().values; expect(values.file_id).toBe('csv-file'); offsets.push(values.batch_offset);
      if (values.batch_offset === 500 && interrupted && !failed) { failed = true; return route.fulfill({ status: 503, json: { error: 'capability_unavailable', message: 'Temporary outage' } }); }
      if (values.batch_offset === 0) return route.fulfill({ json: { executionId: 'batch-first', execution: { status: 'running' } } });
      return route.fulfill({ json: { completed: true, result: { imported: 1, skipped: 0, invalid: 0 } } });
    }
    if (url.pathname.endsWith('/executions/batch-first')) { polls++; return route.fulfill({ json: { completed: true, result: { imported: 498, skipped: 1, invalid: 1, errors: [{ row: 42, message: 'Invalid latitude' }], nextOffset: 500 } } }); }
    return route.fulfill({ json: { type: 'table', columns: [], items: [], total: 0 } });
  });
  await page.goto('/workspace?product=city&page=city-data-ingest');
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({ name: 'assets.csv', mimeType: 'text/csv', buffer: Buffer.from('asset_code,name\nA,Bridge\n') });
  await page.getByRole('button', { name: 'Upload file', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Uploaded' })).toBeVisible();
  const submit = async () => { await page.getByRole('button', { name: 'Run action', exact: true }).click(); await page.getByRole('button', { name: 'Confirm action', exact: true }).click(); };
  await submit();
  if (interrupted) {
    await expect(page.getByRole('alert').filter({ hasText: 'Batch stopped at offset 500' })).toBeVisible();
    await expect(page.getByLabel('Resume at row offset', { exact: true })).toHaveValue('500');
    await submit();
  }
  await expect(page.getByText('Completed successfully.', { exact: true })).toBeVisible();
  await expect(page.getByText('Import results', { exact: true })).toBeVisible();
  expect(offsets).toEqual(interrupted ? [0, 500, 500] : [0, 500]); expect(polls).toBe(1);
  if (!interrupted) { await expect(page.getByText('499', { exact: true })).toBeVisible(); await expect(page.getByText('Invalid latitude', { exact: true })).toBeVisible(); }
});

test('native schema, query and map editors preserve advanced settings and submit through the declared action', async ({ page }) => {
  await setup(page);
  const fields = [
    { name: 'schema', label: 'Request schema', type: 'json', editor: 'schema', defaultValue: JSON.stringify({ type: 'object', description: 'Keep advanced metadata', properties: { name: { type: 'string', minLength: 2 } } }) },
    { name: 'query', label: 'Report query', type: 'json', editor: 'query', defaultValue: JSON.stringify({ limit: 20, where: { status: 'open', reference: '001', threshold: 2, critical: false }, extension: { preserved: true } }) },
    { name: 'geometry_json', label: 'Service area', type: 'json', editor: 'geometry' },
  ];
  const definitions = materializeActions([{ id: 'configure', type: 'form', presentation: 'inline', title: 'Configure workspace data', resource: 'commonForms', action: 'create', fields }]);
  const plugin = { id: 'editors', product: 'city', slug: 'editor-test', name: 'Data editors', roles: ['volunteer'], audience: 'member', version: 1, publishedVersion: 1, publishedAt: stamp, checksum: 'a'.repeat(64), widgets: definitions.map(w => ({ ...w, ...(w.type === 'form' ? { canSubmit: true } : {}) })) };
  const submissions = [];
  await page.route('**/v1/capabilities/workspaces/installed', route => route.fulfill({ json: { items: [plugin] } }));
  await page.route('**/v1/capabilities/workspaces/installed/editors/widgets/configure/execute?*', async route => { expect(new URL(route.request().url()).searchParams.get('action')).toBe('act-configure-submit'); submissions.push(route.request().postDataJSON().values); return route.fulfill({ json: { completed: true, result: {} } }); });
  await page.route('**/v1/capabilities/geo/tiles/**', route => route.fulfill({ status: 404 }));
  await page.goto('/workspace?product=city&page=editor-test');
  await page.getByLabel('Schema title').fill('Site inspection');
  await page.getByRole('button', { name: 'Add schema field', exact: true }).click();
  await page.getByLabel('Schema field field_1', { exact: true }).fill('email');
  await page.getByLabel('Schema field field_1', { exact: true }).press('Tab');
  await page.getByLabel('Format of email', { exact: true }).selectOption('email');
  await page.getByLabel('Query aggregation').selectOption('sum');
  await page.getByLabel('Query value field').fill('cost');
  await page.getByLabel('Filter value status').fill('completed');
  await page.getByLabel('Filter value reference').fill('002');
  await page.getByLabel('Filter value threshold').fill('-3.5');
  await page.getByLabel('Filter value critical').selectOption('true');
  await page.getByRole('button', { name: 'Draw geometry', exact: true }).click();
  await page.getByLabel('Service area drawing type').selectOption('Polygon');
  const map = page.getByLabel('Service area drawing map');
  for (const position of [{ x: 120, y: 80 }, { x: 200, y: 80 }, { x: 180, y: 160 }]) await map.click({ position });
  await page.getByRole('button', { name: 'Use geometry', exact: true }).click();
  await page.screenshot({ path: '/tmp/dx-native-editors.png', fullPage: true });
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click();
  await expect(page.getByText('Completed successfully.', { exact: true })).toBeVisible();
  expect(submissions).toHaveLength(1);
  const schema = JSON.parse(submissions[0].schema), query = JSON.parse(submissions[0].query), geometry = JSON.parse(submissions[0].geometry_json);
  expect(schema.description).toBe('Keep advanced metadata'); expect(schema.properties.name.minLength).toBe(2); expect(schema.properties.email.format).toBe('email');
  expect(query).toEqual({ limit: 20, aggregate: 'sum', field: 'cost', where: { status: 'completed', reference: '002', threshold: -3.5, critical: true }, extension: { preserved: true } });
  expect(geometry.type).toBe('Polygon'); expect(geometry.coordinates[0]).toHaveLength(4); expect(geometry.coordinates[0][0]).toEqual(geometry.coordinates[0][3]);
  const jsonTab = page.getByRole('tablist', { name: 'Service area editor', exact: true }).getByRole('tab', { name: 'JSON', exact: true });
  await jsonTab.click(); await expect(page.getByLabel('Service area', { exact: true })).toHaveValue(JSON.stringify(geometry, null, 2));
});

test('selected record bindings prefill nested geometry without replacing it with the record identifier', async ({ page }) => {
  await setup(page);
  const geometry = { type: 'Point', coordinates: [108.2, 16.1] }, row = { id: 'area-1', name: 'Old service area', metadata: { area: geometry } };
  const other = { id: 'area-2', name: 'Other service area', metadata: { area: { type: 'Point', coordinates: [109.3, 17.2] } } };
  const definitions = materializeActions([
    { id: 'areas', type: 'table', title: 'Saved areas', resource: 'commonForms', columns: ['name', 'metadata'] },
    { id: 'edit-area', type: 'form', presentation: 'inline', title: 'Edit area', resource: 'commonForms', action: 'update', fields: [{ name: 'record_id', label: 'Area record', type: 'text' }, { name: 'geometry_json', label: 'Area geometry', type: 'json', editor: 'geometry', selectionPath: 'metadata.area' }] },
  ]);
  const plugin = { id: 'bound-editor', product: 'city', slug: 'bound-editor-test', name: 'Saved area editor', roles: ['volunteer'], audience: 'member', version: 1, publishedVersion: 1, publishedAt: stamp, checksum: 'a'.repeat(64), widgets: definitions.map(w => ({ ...w, ...(w.type === 'form' ? { canSubmit: true } : {}) })) };
  await page.route('**/v1/capabilities/workspaces/installed', route => route.fulfill({ json: { items: [plugin] } }));
  await page.route('**/v1/capabilities/workspaces/installed/bound-editor/widgets/**', route => route.fulfill({ json: route.request().url().includes('/records/') ? { data: route.request().url().includes('/records/area-2') ? other : row, version: 1 } : { type: 'table', columns: ['name', 'metadata'], items: [row, other], total: 2 } }));
  await page.route('**/v1/capabilities/geo/tiles/**', route => route.fulfill({ status: 404 }));
  await page.goto('/workspace?product=city&page=bound-editor-test');
  await page.getByRole('button', { name: 'Old service area', exact: true }).click(); await page.keyboard.press('Escape');
  await expect(page.getByLabel('Area record', { exact: true })).toHaveValue('area-1');
  await page.getByRole('tablist', { name: 'Area geometry editor', exact: true }).getByRole('tab', { name: 'JSON', exact: true }).click();
  await expect(page.getByLabel('Area geometry', { exact: true })).toHaveValue(JSON.stringify(geometry));
  await page.getByRole('tablist', { name: 'Area geometry editor', exact: true }).getByRole('tab', { name: 'Visual', exact: true }).click();
  await page.getByRole('button', { name: 'Edit vertices', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use geometry', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Other service area', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Area record', { exact: true })).toHaveValue('area-2');
  await expect(page.getByRole('button', { name: 'Use geometry', exact: true })).toHaveCount(0);
  await page.getByRole('tablist', { name: 'Area geometry editor', exact: true }).getByRole('tab', { name: 'JSON', exact: true }).click();
  await expect(page.getByLabel('Area geometry', { exact: true })).toHaveValue(JSON.stringify(other.metadata.area));
});

test('late record details fill untouched fields while preserving the geometry being edited', async ({ page }) => {
  await setup(page);
  const row = { id: 'area-1', name: 'Saved area' };
  const oldGeometry = { type: 'Point', coordinates: [108.2, 16.1] };
  const draftGeometry = JSON.stringify({ type: 'Point', coordinates: [109.1, 17.2] });
  const definitions = materializeActions([
    { id: 'areas', type: 'table', title: 'Saved areas', resource: 'commonForms', columns: ['name'] },
    { id: 'edit-area', type: 'form', presentation: 'inline', title: 'Edit area', resource: 'commonForms', action: 'update', fields: [
      { name: 'record_id', label: 'Area record', type: 'text' },
      { name: 'description', label: 'Area description', type: 'text' },
      { name: 'geometry_json', label: 'Area geometry', type: 'json', editor: 'geometry', selectionPath: 'metadata.area' },
    ] },
  ]);
  const plugin = { id: 'bound-editor', product: 'city', slug: 'bound-editor-test', name: 'Saved area editor', roles: ['volunteer'], audience: 'member', version: 1, publishedVersion: 1, publishedAt: stamp, checksum: 'a'.repeat(64), widgets: definitions.map(w => ({ ...w, ...(w.type === 'form' ? { canSubmit: true } : {}) })) };
  let releaseDetails;
  const gate = new Promise(resolve => { releaseDetails = resolve; });
  await page.route('**/v1/capabilities/workspaces/installed', route => route.fulfill({ json: { items: [plugin] } }));
  await page.route('**/v1/capabilities/workspaces/installed/bound-editor/widgets/**', async route => {
    if (route.request().url().includes('/records/')) {
      await gate;
      return route.fulfill({ json: { data: { ...row, description: 'Loaded description', metadata: { area: oldGeometry } }, version: 1 } });
    }
    return route.fulfill({ json: { type: 'table', columns: ['name'], items: [row], total: 1 } });
  });
  await page.route('**/v1/capabilities/geo/tiles/**', route => route.fulfill({ status: 404 }));
  await page.goto('/workspace?product=city&page=bound-editor-test');
  await page.getByRole('button', { name: 'Saved area', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('tablist', { name: 'Area geometry editor', exact: true }).getByRole('tab', { name: 'JSON', exact: true }).click();
  await page.getByLabel('Area geometry', { exact: true }).fill(draftGeometry);
  releaseDetails();
  await expect(page.getByLabel('Area description', { exact: true })).toHaveValue('Loaded description');
  await expect(page.getByLabel('Area geometry', { exact: true })).toHaveValue(draftGeometry);
  await expect(page.getByLabel('Area record', { exact: true })).toHaveValue('area-1');
});
