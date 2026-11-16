// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from "@tanstack/react-router";
import { WorkspacesPage } from "../../pages/admin/WorkspacesPage";

export const Route = createFileRoute("/admin/workspaces")({
  validateSearch: (search: Record<string, unknown>) => ({
    product:
      search.product === "sos"
        ? ("sos" as const)
        : search.product === "dx"
          ? ("dx" as const)
          : search.product === "city"
            ? ("city" as const)
            : undefined,
    plugin:
      typeof search.plugin === "string" &&
      /^[A-Za-z0-9_-]{1,120}$/.test(search.plugin)
        ? search.plugin
        : undefined,
  }),
  component: WorkspacesPage,
});
