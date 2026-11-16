// SPDX-License-Identifier: Apache-2.0
import template from "./commonTemplate.json";
import { materializeActions } from "./studioActions";
import type { WorkspaceWidget } from "./workspaces";

/** Slice the visual template before authoring actions, so no removed target survives. */
export function commonTemplateForSection(section: string): WorkspaceWidget[] {
  const widgets = (template as WorkspaceWidget[])
    .filter(widget => !widget.section || widget.section === section)
    .map(widget => ({
      ...structuredClone(widget),
      ...(widget.links ? { links: widget.links.filter(link => link.target === `section:${section}`) } : {}),
    }));
  return materializeActions(widgets);
}
