// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { FileField } from "./FileField";
import { StructuredJsonField } from "./StructuredJsonField";
import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { WorkspaceActions } from "./WorkspaceActions";
import type { ReferenceOptions } from "../../lib/workspacesApi";
import { inputClassName } from "../ui";
import type { WorkspaceField } from "../../lib/workspaces";
export function BoundField({
  field,
  id,
  value,
  onChange,
  installedId,
  widgetId,
}: {
  field: WorkspaceField;
  id: string;
  value: string;
  onChange: (value: string) => void;
  installedId?: string;
  widgetId: string;
}) {
  const actions = useContext(WorkspaceActions);
  const options = useQuery({
    queryKey: ["workspace-reference", installedId, widgetId, field.name, field.optionsAction, actions?.queryKey(field.optionsAction || "")],
    queryFn: async () => await actions!.run(field.optionsAction!, {}, { silent: true }) as ReferenceOptions,
    enabled: !!installedId && !!field.optionsResource && !!field.optionsAction && !!actions,
    retry: false,
  });
  const common = {
    id,
    name: field.name,
    "aria-label": field.label,
    required: field.required,
    className: inputClassName,
  };
  if (field.type === "file") return <FileField field={field} id={id} value={value} onChange={onChange} enabled={!!installedId && !!actions} />;
  if (field.type === "json" && field.editor && field.editor !== "json") return <StructuredJsonField field={field} id={id} value={value} onChange={onChange} />;
  if (field.type === "select")
    return (
      <>
        <select
          {...common}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">
            {options.isLoading ? "Loading options…" : "Choose an option"}
          </option>
          {(field.options || []).map((option) => (
            <option key={option} value={option}>
              {option.replaceAll("_", " ")}
            </option>
          ))}
          {options.data?.items.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {options.isError ? (
          <p role="alert" className="mt-1 text-xs text-rose-600">
            Reference options unavailable.
          </p>
        ) : null}
        {options.data && options.data.total > options.data.items.length ? (
          <p className="mt-1 text-xs text-dx-muted">Showing {options.data.items.length} of {options.data.total} options. Adjust the query filter in Studio.</p>
        ) : null}
      </>
    );
  if (field.type === "checkbox")
    return (
      <input
        id={id}
        name={field.name}
        aria-label={field.label}
        type="checkbox"
        checked={value === "true"}
        onChange={(event) => onChange(String(event.target.checked))}
      />
    );
  if (["textarea", "json", "markdown"].includes(field.type))
    return (
      <textarea
        {...common}
        rows={field.type === "markdown" ? 9 : 4}
        maxLength={50000}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={field.type !== "json"}
      />
    );
  return (
    <input
      {...common}
      type={
        ["number", "date", "datetime-local", "email"].includes(field.type)
          ? field.type
          : "text"
      }
      step={field.type === "number" ? "any" : undefined}
      value={value}
      maxLength={4000}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
