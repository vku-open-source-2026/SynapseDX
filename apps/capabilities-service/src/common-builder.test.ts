import { materializeActions } from "./studio-actions";
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api, startHarness } from "./testing/harness";
import {
  buildBundle,
  parseBundle,
  parseWidgets,
  workspaceLimits,
  type WorkspacePluginRecord,
} from "./workspace-plugins";
import { COLLECTIONS } from "./platform";
import { validateCommonValues } from "./common-builder";

const template: any[] = materializeActions<any>(
  JSON.parse(
    readFileSync(
      resolve(__dirname, "../../../console/src/lib/commonTemplate.json"),
      "utf8",
    ),
  ),
);
test("declarative Common pages preserve all sections, fields, layout and board actions through export/import", () => {
  for (const product of ["city", "sos"] as const) {
    const widgets = parseWidgets(template, product, workspaceLimits());
    const bundle = buildBundle(
      {
        product,
        name: "Common workspace",
        slug: product + "-common-workspace",
        audience: "member",
        roles: ["volunteer"],
        widgets,
      } as WorkspacePluginRecord,
      new Map(),
    );
    assert.deepEqual(
      parseBundle(bundle, workspaceLimits()).plugin.widgets,
      widgets,
    );
    assert.equal(
      widgets.some((widget) => widget.type === "capability"),
      false,
    );
    assert.equal(
      new Set(widgets.map((widget) => widget.section).filter(Boolean)).size,
      9,
    );
  }
  assert.throws(() =>
    parseWidgets(
      template.map((widget: any) =>
        widget.id === "task-board"
          ? { ...widget, updateForm: "missing" }
          : widget,
      ),
      "city",
      workspaceLimits(),
    ),
  );
});

test("declared fields enforce numeric, boolean, date, email, JSON and select values", () => {
  for (const [type, value] of [
    ["number", "1"],
    ["checkbox", "false"],
    ["date", "tomorrow"],
    ["email", "invalid"],
    ["json", "{broken"],
  ] as const) {
    assert.throws(() =>
      validateCommonValues([{ name: "field", label: "Field", type }], {
        field: value,
      }),
    );
  }
  assert.throws(() =>
    validateCommonValues(
      [
        {
          name: "status",
          label: "Status",
          type: "select",
          options: ["todo", "doing", "done"],
        },
      ],
      { status: "admin" },
    ),
  );
  assert.throws(() =>
    validateCommonValues([{ name: "title", label: "Title", type: "text" }], {
      title: "x",
      tenant: "another-app",
    }),
  );
  assert.deepEqual(
    validateCommonValues([{ name: "ok", label: "OK", type: "checkbox" }], {
      ok: false,
    }),
    { ok: false },
  );
});

test("installed declarative pages execute Common CRUD with caller authority and app isolation", async () => {
  const h = await startHarness();
  // Test-only self forwarding. Never send fixture credentials to the public production URL.
  h.config.publicUrl = h.base;
  try {
    const admin = (path: string, method = "GET", body?: unknown) =>
      api(h, "/v1/capabilities/workspaces/" + path, {
        token: "admin-token",
        method,
        ...(body ? { body } : {}),
      });
    await admin("members/member-1", "PUT", {
      productRoles: { city: ["volunteer"], sos: ["volunteer"] },
    });
    await admin("members/moderator-1", "PUT", {
      productRoles: { city: ["volunteer"] },
    });
    const ids: Record<string, string> = {};
    for (const product of ["city", "sos"]) {
      const created = await admin("plugins", "POST", {
        product,
        name: "Common workspace",
        slug: product + "-common-workspace",
        audience: "member",
        roles: ["volunteer"],
        widgets: template,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      ids[product] = created.body.id;
      assert.equal(
        (await admin(`plugins/${ids[product]}/publish`, "POST")).status,
        200,
      );
      assert.equal(
        (
          await admin(`plugins/${ids[product]}/install`, "POST", {
            roles: ["volunteer"],
          })
        ).status,
        201,
      );
      assert.equal(
        (await admin(`plugins/${ids[product]}/provision`, "POST")).status,
        200,
        "Common bindings must not provision product datasets",
      );
    }
    const referenceAction = (path: string) => {
      const [id, kind, field] = path.split("/");
      const widget = template.find((w: any) => w.id === id);
      return kind === "options"
        ? widget.fields.find((f: any) => f.name === field).optionsAction
        : kind === "records"
          ? widget.onRowClick
          : kind === "execute"
            ? widget.onSubmit
            : widget.onLoad;
    };
    const request = (
      app: string,
      path: string,
      method = "GET",
      body?: unknown,
      token = "member-token",
    ) =>
      api(
        h,
        `/v1/capabilities/workspaces/installed/${ids[app]}/widgets/${path}${path.includes("?") ? "&" : "?"}action=${encodeURIComponent(referenceAction(path))}`,
        { token, method, ...(body ? { body } : {}) },
      );
    const run = (app: string, id: string, values: unknown) =>
      request(app, id + "/execute", "POST", { values });
    const installed = await api(h, "/v1/capabilities/workspaces/installed", {
      token: "member-token",
    });
    assert.equal(
      installed.body.items[0].widgets.find((w: any) => w.id === "task-create")
        .canSubmit,
      true,
    );
    const project = await run("city", "project-create", {
      name: "City project",
      startDate: "2026-11-01",
      endDate: "2026-12-01",
      budget: 100,
    });
    assert.equal(project.status, 200, JSON.stringify(project.body));
    assert.equal(project.body.completed, true);
    const projectId = project.body.result.project.id;
    const options = await request("city", "task-create/options/projectId");
    assert.deepEqual(options.body.items, [
      { value: projectId, label: "City project" },
    ]);
    assert.deepEqual(
      (await request("sos", "task-create/options/projectId")).body.items,
      [],
    );
    const task = await run("city", "task-create", {
      projectId,
      title: "Inspect road",
      status: "todo",
      estimateHours: 2,
    });
    assert.equal(task.status, 200, JSON.stringify(task.body));
    const taskId = task.body.result.task.id;
    assert.equal(
      (await run("city", "task-status", { record_id: taskId, status: "done" }))
        .status,
      200,
    );
    const board = await request("city", "task-board/data");
    assert.equal(board.status, 200, JSON.stringify(board.body));
    assert.equal(board.body.items[0].status, "done");
    assert.equal(
      (await request("city", `task-board/records/${taskId}`)).body.data.title,
      "Inspect road",
    );
    assert.equal((await request("sos", "task-board/data")).body.total, 0);
    assert.equal(
      (await run("sos", "task-status", { record_id: taskId, status: "todo" }))
        .status,
      404,
    );
    assert.equal(
      (await run("city", "task-status", { record_id: taskId, status: "wrong" }))
        .status,
      400,
    );
    assert.equal(
      (
        await run("city", "task-create", {
          projectId,
          title: "Bad",
          estimateHours: "2",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await run("city", "task-create", {
          projectId,
          title: "Bad",
          tenant: "org-b",
        })
      ).status,
      400,
    );
    // Collections and metrics must include data after the capability's first page.
    const stored = h.fake.collections.get(COLLECTIONS.projectTasks)!;
    const original = stored.get(taskId)!;
    for (let index = 1; index < 105; index++) {
      const id = `pagination-${String(index).padStart(4, "0")}`;
      stored.set(id, {
        ...original,
        id,
        data: { ...original.data, id, title: `Task ${index}` },
      });
    }
    const paged = await request("city", "task-board/data?offset=100&limit=10");
    assert.equal(paged.status, 200, JSON.stringify(paged.body));
    assert.equal(paged.body.total, 105);
    assert.equal(paged.body.items.length, 5);
    assert.equal((await request("city", "task-count/data")).body.count, 105);
    assert.equal(
      (
        await run("city", "task-status", {
          record_id: "../../foreign",
          status: "todo",
        })
      ).status,
      400,
    );
    const space = await run("city", "wiki-space-create", {
      name: "Private knowledge",
      visibility: "private",
      para: "areas",
    });
    assert.equal(space.status, 200, JSON.stringify(space.body));
    const spaceId = space.body.result.workspace.id;
    const page = await run("city", "wiki-create", {
      workspaceId: spaceId,
      title: "Procedure",
      markdown: "# Inspect\n- Check the road",
      tags: '["guide"]',
    });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const pageId = page.body.result.page.id;
    assert.equal(
      (await request("city", "wiki-pages/data")).body.items[0].id,
      pageId,
    );
    assert.equal(
      (
        await request(
          "city",
          "wiki-pages/data",
          "GET",
          undefined,
          "moderator-token",
        )
      ).body.total,
      0,
      "Private space ACL must apply to collection binding",
    );
    assert.equal(
      (await request("sos", `wiki-pages/records/${pageId}`)).status,
      404,
    );
    assert.equal(
      (
        await run("city", "wiki-edit", {
          record_id: pageId,
          title: "Updated",
          markdown: "New content",
          tags: "{bad",
        })
      ).status,
      400,
    );
    const formWidget = template.find(
      (widget: any) => widget.id === "form-create",
    );
    const form = await run("city", "form-create", {
      name: "Inspection",
      schema: formWidget.fields.find((field: any) => field.name === "schema")
        .defaultValue,
      published: true,
    });
    assert.equal(form.status, 200, JSON.stringify(form.body));
    const checked = await run("city", "form-validate", {
      record_id: form.body.result.form.id,
      values: "{}",
    });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.result.valid, false);
    assert.equal(
      (
        await request(
          "city",
          "task-board/data",
          "GET",
          undefined,
          "other-token",
        )
      ).status,
      404,
    );
    await admin("members/member-1", "PUT", {
      productRoles: { sos: ["volunteer"] },
    });
    assert.equal(
      (await request("city", "task-board/data")).status,
      404,
      "Revocation must apply to declarative data",
    );
  } finally {
    await h.close();
  }
});
