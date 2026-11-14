// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Visual low-code plugin builder. Everything is declarative: widgets are added
 * from a fixed safe palette, reordered, configured against catalog keys, and
 * previewed. No JSON editor is required and no schema value is ever executed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  Download,
  FileJson,
  GripVertical,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import {
  Button,
  Card,
  CardHeader,
  Field,
  EmptyState,
  Pill,
  SmallButton,
  inputClassName,
  selectClassName,
} from '../../../components/ui';
import { Modal, ModalError } from '../../../components/Modal';
import { SafeWidget } from '../../../components/workspaces/SafeWidget';
import { toast } from '../../../stores/toastStore';
import {
  catalogActionTypes,
  catalogMutation,
  catalogResources,
  catalogRoles,
  catalogWidgetTypes,
  exportBundleFileName,
  isSafeWorkflowArtifactId,
  moveItem,
  nextWidgetId,
  parsePluginBundle,
  slugify,
  toWriteWidget,
  validatePluginDraft,
  validateWidget,
  type PluginBundle,
  type ValidationIssue,
  type WorkspaceCatalog,
  type WorkspaceField,
  type WorkspaceFormAction,
  type WorkspaceOrgReadiness,
  type WorkspacePlugin,
  type WorkspaceProduct,
  type WorkspaceWidget,
  type WorkspaceWidgetType,
} from '../../../lib/workspaces';
import {
  buildPluginBundle,
  createPlugin,
  exportPluginBundle,
  fetchWorkflowArtifacts,
  importPluginBundle,
  publishPlugin,
  unpublishPlugin,
  updatePlugin,
} from '../../../lib/workspacesApi';
import type { WorkflowArtifactSummary } from '../../../lib/workspaces';

interface BuilderPanelProps {
  product: WorkspaceProduct;
  catalog: WorkspaceCatalog | null;
  plugins: WorkspacePlugin[];
  loading: boolean;
  onChanged: () => void;
}

interface BuildArtifact {
  pluginName: string;
  version: number;
  repository: string;
  path: string;
  checksum: string;
  filename: string;
}

const WIDGET_LABELS: Record<WorkspaceWidgetType, string> = {
  text: 'Text',
  metric: 'Metric',
  table: 'Table',
  form: 'Form',
};

function clonePlugin(plugin: WorkspacePlugin): WorkspacePlugin {
  return JSON.parse(JSON.stringify(plugin)) as WorkspacePlugin;
}

function snapshotOf(plugin: WorkspacePlugin): string {
  return JSON.stringify({
    name: plugin.name,
    slug: plugin.slug,
    audience: plugin.audience,
    roles: plugin.roles,
    widgets: plugin.widgets,
  });
}

function errorText(error: unknown): string {
  const value = error as { message?: string; code?: string };
  const message = value?.message || 'The capability service refused the request.';
  return value?.code ? `${message} (${value.code})` : message;
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function defaultWidget(type: WorkspaceWidgetType, existing: string[], resources: string[]): WorkspaceWidget {
  const widget: WorkspaceWidget = {
    id: nextWidgetId(type, existing),
    type,
    title: `New ${WIDGET_LABELS[type].toLowerCase()}`,
    width: 'half',
  };
  if (type === 'text') widget.text = '';
  if (type !== 'text') {
    if (resources[0]) widget.resource = resources[0];
  }
  if (type === 'table') widget.columns = ['id'];
  if (type === 'form') {
    widget.action = 'create';
    widget.fields = [{ name: 'notes', label: 'Notes', type: 'textarea' }];
  }
  return widget;
}

function Issues({ issues, max = 8 }: { issues: ValidationIssue[]; max?: number }) {
  if (issues.length === 0) return null;
  return (
    <ul role="alert" className="space-y-1 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
      {issues.slice(0, max).map((issue, index) => (
        <li key={`${issue.path}-${index}`}>
          {issue.path ? <span className="font-mono">{issue.path}</span> : null}
          {issue.path ? ': ' : ''}
          {issue.message}
        </li>
      ))}
      {issues.length > max ? <li>…and {issues.length - max} more issue(s).</li> : null}
    </ul>
  );
}

function WidgetEditor({
  widget,
  index,
  resources,
  artifacts,
  artifactsError,
  formExecutionReady,
  formExecutionRequirement,
  actions,
  orgReadiness,
  onChange,
}: {
  widget: WorkspaceWidget;
  index: number;
  resources: string[];
  artifacts: WorkflowArtifactSummary[];
  artifactsError: string | null;
  formExecutionReady: boolean;
  formExecutionRequirement?: string;
  actions: WorkspaceFormAction[];
  orgReadiness?: WorkspaceOrgReadiness;
  onChange: (patch: Partial<WorkspaceWidget>) => void;
}) {
  const [columnsText, setColumnsText] = useState((widget.columns ?? []).join(', '));

  useEffect(() => {
    setColumnsText((widget.columns ?? []).join(', '));
  }, [widget.id]);

  const issues = validateWidget(widget, index);
  const boundArtifact = widget.workflowArtifactId
    ? artifacts.find((artifact) => artifact.id === widget.workflowArtifactId)
    : undefined;

  const updateField = (fieldIndex: number, patch: Partial<WorkspaceField>) => {
    const fields = (widget.fields ?? []).map((field, current) =>
      current === fieldIndex ? { ...field, ...patch } : field,
    );
    onChange({ fields });
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_130px]">
        <Field label="Widget title" required>
          <input
            className={inputClassName}
            value={widget.title}
            maxLength={200}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </Field>
        <Field label="Width">
          <select
            className={selectClassName}
            value={widget.width ?? 'half'}
            onChange={(event) => onChange({ width: event.target.value as 'full' | 'half' })}
          >
            <option value="half">Half</option>
            <option value="full">Full</option>
          </select>
        </Field>
      </div>

      {widget.type === 'text' ? (
        <Field label="Plain text" help="No HTML, JavaScript, eval or URLs. Line breaks are preserved.">
          <textarea
            className={`${inputClassName} min-h-[120px]`}
            value={widget.text ?? ''}
            maxLength={4000}
            onChange={(event) => onChange({ text: event.target.value })}
          />
        </Field>
      ) : null}

      {widget.type === 'metric' || widget.type === 'table' ? (
        <Field
          label="Catalog resource"
          required
          help="Only resource keys are stored. The browser never receives a product URL or dataset id."
        >
          <select
            className={selectClassName}
            value={widget.resource ?? ''}
            onChange={(event) => onChange({ resource: event.target.value || undefined })}
          >
            <option value="">Choose a resource</option>
            {resources.map((resource) => (
              <option key={resource} value={resource}>{resource}</option>
            ))}
          </select>
        </Field>
      ) : null}

      {widget.type === 'table' ? (
        <Field
          label="Columns"
          help="Comma-separated field names. Leave empty to use columns returned by the capability service."
        >
          <input
            className={inputClassName}
            value={columnsText}
            placeholder="id, status, updatedAt"
            onChange={(event) => {
              const next = event.target.value;
              setColumnsText(next);
              const columns = next
                .split(',')
                .map((column) => column.trim())
                .filter(Boolean);
              onChange({ columns });
            }}
          />
        </Field>
      ) : null}

      {widget.type === 'form' ? (
        <div className="space-y-3">
          {!formExecutionReady || (orgReadiness && !orgReadiness.ready) ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
              <p className="font-semibold">Form execution is currently unavailable.</p>
              {!formExecutionReady ? (
                <p>{formExecutionRequirement || 'The capability service reports the global execution gate is closed.'}</p>
              ) : null}
              {orgReadiness && !orgReadiness.ready ? (
                <p>
                  {orgReadiness.requirement}
                  {orgReadiness.reason ? ` (${orgReadiness.reason})` : ''}
                </p>
              ) : null}
            </div>
          ) : null}
          <Field
            label="Declared action"
            help="The bound workflow performs the operation. The action is declarative metadata for the product workflow."
          >
            <select
              className={selectClassName}
              value={widget.action ?? 'create'}
              onChange={(event) =>
                onChange({ action: event.target.value as WorkspaceWidget['action'] })
              }
            >
              {actions.map((action) => (
                <option key={action} value={action}>{action}</option>
              ))}
            </select>
          </Field>

          <Field label="Catalog resource" required>
            <select
              className={selectClassName}
              value={widget.resource ?? ''}
              onChange={(event) => onChange({ resource: event.target.value || undefined })}
            >
              <option value="">Choose a resource</option>
              {resources.map((resource) => (
                <option key={resource} value={resource}>{resource}</option>
              ))}
            </select>
          </Field>

          <Field
            label="Bound workflow artifact"
            help="Form values are sent only to this same-organization workflow. Unbound forms stay read-only in the member workspace."
          >
            <select
              className={selectClassName}
              value={widget.workflowArtifactId ?? ''}
              onChange={(event) => onChange({ workflowArtifactId: event.target.value || undefined })}
            >
              <option value="">Unbound (read-only)</option>
              {widget.workflowArtifactId && !boundArtifact ? (
                <option value={widget.workflowArtifactId}>
                  {widget.workflowArtifactId} (not in the current list)
                </option>
              ) : null}
              {artifacts.map((artifact) => (
                <option key={artifact.id} value={artifact.id}>
                  {artifact.name}
                  {artifact.active ? '' : ' (inactive)'}
                  {artifact.syncState && artifact.syncState !== 'ready' ? ` (${artifact.syncState})` : ''} ·{' '}
                  {artifact.id}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Artifact id"
            help="Selection or direct input. The capability service verifies same-organization ownership before execution."
          >
            <input
              className={inputClassName}
              value={widget.workflowArtifactId ?? ''}
              placeholder="artifact id"
              onChange={(event) => onChange({ workflowArtifactId: event.target.value || undefined })}
            />
          </Field>

          {artifactsError ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
              Workflow artifacts could not be listed: {artifactsError}. You can paste an artifact id; execution stays
              server-validated.
            </p>
          ) : null}
          {boundArtifact && !boundArtifact.active ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
              This artifact is inactive. Execution may be refused by the workflow capability.
            </p>
          ) : null}
          {boundArtifact && boundArtifact.syncState && boundArtifact.syncState !== 'ready' ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
              This artifact sync state is <span className="font-mono">{boundArtifact.syncState}</span>. Reconcile it in{' '}
              <a className="font-semibold underline underline-offset-2" href="/admin/workflows">Workflows</a> before
              publishing or execution.
            </p>
          ) : null}
          {widget.workflowArtifactId && !isSafeWorkflowArtifactId(widget.workflowArtifactId) ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
              Artifact id must be 8–120 letters, digits, underscores or hyphens.
            </p>
          ) : null}

          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Declared fields</p>
              <SmallButton
                type="button"
                onClick={() =>
                  onChange({
                    fields: [
                      ...(widget.fields ?? []),
                      {
                        name: `field${(widget.fields?.length ?? 0) + 1}`,
                        label: 'New field',
                        type: 'text',
                      },
                    ],
                  })
                }
                disabled={(widget.fields?.length ?? 0) >= 30}
              >
                <Plus size={13} /> Add field
              </SmallButton>
            </div>
            <div className="space-y-2">
              {(widget.fields ?? []).map((field, fieldIndex) => (
                <div
                  key={fieldIndex}
                  className="grid gap-2 rounded-xl border border-slate-200 p-2 dark:border-[#26354d] sm:grid-cols-[1fr_1fr_110px_70px_34px]"
                >
                  <input
                    className={`${inputClassName} py-1.5 text-xs`}
                    value={field.name}
                    placeholder="name"
                    maxLength={64}
                    onChange={(event) => updateField(fieldIndex, { name: event.target.value })}
                  />
                  <input
                    className={`${inputClassName} py-1.5 text-xs`}
                    value={field.label}
                    placeholder="Label"
                    maxLength={200}
                    onChange={(event) => updateField(fieldIndex, { label: event.target.value })}
                  />
                  <select
                    className={`${selectClassName} py-1.5 text-xs`}
                    value={field.type}
                    onChange={(event) =>
                      updateField(fieldIndex, { type: event.target.value as WorkspaceField['type'] })
                    }
                  >
                    <option value="text">text</option>
                    <option value="number">number</option>
                    <option value="textarea">textarea</option>
                  </select>
                  <label className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={field.required === true}
                      onChange={(event) => updateField(fieldIndex, { required: event.target.checked })}
                    />
                    Req.
                  </label>
                  <SmallButton
                    type="button"
                    variant="danger"
                    aria-label={`Remove field ${field.label}`}
                    onClick={() =>
                      onChange({ fields: (widget.fields ?? []).filter((_, current) => current !== fieldIndex) })
                    }
                  >
                    <Trash2 size={13} />
                  </SmallButton>
                </div>
              ))}
              {(widget.fields?.length ?? 0) === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">Add at least one declared field.</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <p className="text-[11px] text-slate-500 dark:text-slate-400">
        {widget.type === 'form'
          ? 'Execution runs the bound workflow through Tier 1. Only declared fields are submitted.'
          : 'Data is read through the DX runtime endpoint, never through the Tier-3 product API.'}
      </p>
      <Issues issues={issues} max={4} />
    </div>
  );
}

export function BuilderPanel({ product, catalog, plugins, loading, onChanged }: BuilderPanelProps) {
  const [draft, setDraft] = useState<WorkspacePlugin | null>(null);
  const [baseline, setBaseline] = useState('');
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newSlugTouched, setNewSlugTouched] = useState(false);
  const [newAudience, setNewAudience] = useState<'admin' | 'member'>('member');
  const [importOpen, setImportOpen] = useState(false);
  const [pendingBundle, setPendingBundle] = useState<PluginBundle | null>(null);
  const [importIssues, setImportIssues] = useState<ValidationIssue[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [buildArtifact, setBuildArtifact] = useState<BuildArtifact | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const artifactsQuery = useQuery({
    queryKey: ['workflow-artifacts'],
    queryFn: fetchWorkflowArtifacts,
    retry: false,
  });

  const resources = useMemo(
    () => catalogResources(catalog, product).map((resource) => resource.key),
    [catalog, product],
  );
  const roles = useMemo(() => catalogRoles(catalog, product), [catalog, product]);
  const widgetTypes = useMemo(() => catalogWidgetTypes(catalog, product), [catalog, product]);
  const actionTypes = useMemo(() => catalogActionTypes(catalog, product), [catalog, product]);
  const orgReadiness = catalog?.workflowOrgReadiness;
  const mutation = useMemo(() => catalogMutation(catalog), [catalog]);

  useEffect(() => {
    if (draft) return;
    const first = plugins[0];
    if (!first) {
      setBaseline('');
      setSelectedWidgetId(null);
      return;
    }
    const cloned = clonePlugin(first);
    setDraft(cloned);
    setBaseline(snapshotOf(cloned));
    setSelectedWidgetId(cloned.widgets[0]?.id ?? null);
  }, [plugins, draft]);

  const isDirty = Boolean(draft && snapshotOf(draft) !== baseline);
  const allIssues = useMemo(
    () => (draft ? validatePluginDraft(draft, { allowedRoles: roles.length > 0 ? roles : undefined }) : []),
    [draft, roles],
  );
  const selectedIndex = draft?.widgets.findIndex((widget) => widget.id === selectedWidgetId) ?? -1;
  const selectedWidget = selectedIndex >= 0 ? draft?.widgets[selectedIndex] ?? null : null;

  const loadPlugin = (plugin: WorkspacePlugin) => {
    const cloned = clonePlugin(plugin);
    setDraft(cloned);
    setBaseline(snapshotOf(cloned));
    setSelectedWidgetId(cloned.widgets[0]?.id ?? null);
    setIssues([]);
    setError(null);
    setPreview(false);
  };

  const selectPlugin = (plugin: WorkspacePlugin) => {
    if (draft && isDirty && !window.confirm('Discard unsaved changes to this draft?')) return;
    loadPlugin(plugin);
  };

  const patchDraft = (patch: Partial<WorkspacePlugin>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const patchWidget = (id: string, patch: Partial<WorkspaceWidget>) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            widgets: current.widgets.map((widget) => (widget.id === id ? { ...widget, ...patch } : widget)),
          }
        : current,
    );
  };

  const addWidget = (type: WorkspaceWidgetType) => {
    if (!draft) return;
    const widget = defaultWidget(type, draft.widgets.map((item) => item.id), resources);
    patchDraft({ widgets: [...draft.widgets, widget] });
    setSelectedWidgetId(widget.id);
    setPreview(false);
  };

  const moveWidget = (from: number, to: number) => {
    if (!draft) return;
    patchDraft({ widgets: moveItem(draft.widgets, from, to) });
  };

  const save = async () => {
    if (!draft || busy) return;
    const validation = validatePluginDraft(draft, { allowedRoles: roles.length > 0 ? roles : undefined });
    setIssues(validation);
    setError(null);
    if (validation.length > 0) return;
    setBusy('save');
    try {
      const body = {
        product: draft.product,
        name: draft.name.trim(),
        slug: draft.slug.trim(),
        audience: draft.audience,
        roles: draft.roles,
        widgets: draft.widgets.map(toWriteWidget),
        ...(draft.id ? { version: draft.version } : {}),
      };
      const saved = draft.id ? await updatePlugin(draft.id, body) : await createPlugin(body);
      loadPlugin(saved);
      toast(draft.id ? 'Draft saved.' : 'Plugin created as a draft.');
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    if (!draft?.id || busy) return;
    if (isDirty) {
      setError('Save the draft before publishing.');
      return;
    }
    if (allIssues.length > 0) {
      setIssues(allIssues);
      return;
    }
    setBusy('publish');
    setError(null);
    try {
      const published = await publishPlugin(draft.id, draft.version);
      loadPlugin(published);
      toast('Published immutable snapshot.');
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const unpublish = async () => {
    if (!draft?.id || busy) return;
    setBusy('unpublish');
    setError(null);
    try {
      const result = await unpublishPlugin(draft.id, draft.version);
      loadPlugin(result);
      toast('Plugin unpublished.');
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const exportBundle = async () => {
    if (!draft?.id || busy) return;
    setBusy('export');
    setError(null);
    try {
      // Export is the authoring/backup view and intentionally serializes the
      // editable draft. The Tier-3 build below uses the immutable snapshot.
      const raw = await exportPluginBundle(draft.id, { draft: true });
      const parsed = parsePluginBundle(raw);
      if (!parsed.ok) {
        setIssues(parsed.issues);
        setError('The exported bundle failed client validation; nothing was downloaded.');
        return;
      }
      downloadJson(exportBundleFileName(draft), raw);
      toast('Draft bundle downloaded.');
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const buildForTier3 = async () => {
    if (!draft?.id || busy) return;
    setBusy('build');
    setError(null);
    try {
      const raw = await buildPluginBundle(draft.id);
      const parsed = parsePluginBundle(raw);
      if (!parsed.ok || !parsed.bundle.source) {
        if (!parsed.ok) setIssues(parsed.issues);
        setError('The Tier-3 build failed client validation; nothing was downloaded.');
        return;
      }
      const filename = parsed.bundle.source.path.split('/').pop() || `${draft.slug}.plugin.json`;
      downloadJson(filename, raw);
      setBuildArtifact({
        pluginName: parsed.bundle.plugin.name,
        version: draft.publishedVersion ?? draft.version,
        repository: parsed.bundle.source.repository,
        path: parsed.bundle.source.path,
        checksum: parsed.bundle.checksum ?? 'missing',
        filename,
      });
      toast('Tier-3 build downloaded.');
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const readImportFile = async (file: File | null) => {
    if (!file) return;
    setImportIssues([]);
    setImportError(null);
    setPendingBundle(null);
    if (file.size > 256 * 1024) {
      setImportIssues([{ path: 'file', message: 'Bundle file must be 256 KiB or smaller.' }]);
      setImportOpen(true);
      return;
    }
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setImportIssues([{ path: 'file', message: 'The file is not valid JSON.' }]);
        setImportOpen(true);
        return;
      }
      const result = parsePluginBundle(parsed);
      if (!result.ok) {
        setImportIssues(result.issues);
        setImportOpen(true);
        return;
      }
      setPendingBundle(result.bundle);
      setImportOpen(true);
    } catch (failure) {
      setImportIssues([{ path: 'file', message: errorText(failure) }]);
      setImportOpen(true);
    }
  };

  const confirmImport = async () => {
    if (!pendingBundle || busy) return;
    setBusy('import');
    setImportError(null);
    try {
      const imported = await importPluginBundle(pendingBundle);
      loadPlugin(imported);
      setImportOpen(false);
      setPendingBundle(null);
      toast('Bundle imported as a draft. It was not installed.');
      onChanged();
    } catch (failure) {
      setImportError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const createNew = () => {
    const name = newName.trim();
    const slug = (newSlugTouched ? newSlug : slugify(name)).trim();
    if (!name || !slug) {
      setIssues([{ path: 'name', message: 'A name and slug are required.' }]);
      return;
    }
    const plugin: WorkspacePlugin = {
      id: '',
      product,
      name,
      slug,
      audience: newAudience,
      roles: [],
      widgets: [],
      status: 'draft',
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      installed: false,
    };
    setDraft(plugin);
    setBaseline(snapshotOf(plugin));
    setSelectedWidgetId(null);
    setIssues([]);
    setError(null);
    setNewOpen(false);
    setNewName('');
    setNewSlug('');
    setNewSlugTouched(false);
    setNewAudience('member');
  };

  const roleOptions = useMemo(() => {
    const union = new Set<string>([...roles, ...(draft?.roles ?? [])]);
    return Array.from(union);
  }, [roles, draft]);

  const artifactOptions = artifactsQuery.data ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          eyebrow={`${product.toUpperCase()} · plugin builder`}
          title="Pages installed by your organization"
          description="Design admin or member pages with safe declarative widgets. Publish creates an immutable snapshot used by /workspace."
          actions={
            <>
              <Button variant="ghost" onClick={() => void onChanged()} disabled={Boolean(busy)}>
                <RefreshCw size={14} /> Refresh
              </Button>
              <Button variant="ghost" onClick={() => fileInput.current?.click()} disabled={Boolean(busy)}>
                <Upload size={14} /> Import bundle
              </Button>
              <Button variant="primary" onClick={() => setNewOpen(true)} disabled={Boolean(busy)}>
                <Plus size={14} /> New plugin
              </Button>
            </>
          }
        />
        <div className="flex flex-wrap items-center gap-2 px-5 py-3 text-xs text-slate-500 dark:text-slate-400">
          <span>{plugins.length} plugin(s) for {product}</span>
          {!mutation.formExecution ? (
            <Pill tone="warn">
              {catalog
                ? `Form execution is not advertised${mutation.reason ? `: ${mutation.reason}` : ''}`
                : 'Form execution support unknown while the catalog is unavailable'}
            </Pill>
          ) : (
            <Pill tone="ok">Workflow form execution advertised</Pill>
          )}
          {orgReadiness ? (
            <span title={orgReadiness.requirement}>
              <Pill tone={orgReadiness.ready ? 'ok' : 'warn'}>
                org workflow: {orgReadiness.ready ? 'verified' : orgReadiness.reason || 'not ready'}
              </Pill>
            </span>
          ) : null}
          <span>Only an explicit workflow artifact binding enables a member form.</span>
          {orgReadiness && !orgReadiness.ready ? (
            <span className="text-amber-700 dark:text-amber-300">
              {orgReadiness.requirement}{' '}
              <a className="font-semibold underline underline-offset-2" href="/admin/workflows">
                Review workflow artifacts
              </a>
            </span>
          ) : null}
        </div>
      </Card>

      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          void readImportFile(event.target.files?.[0] ?? null);
          event.target.value = '';
        }}
      />

      {error ? <ModalError message={error} /> : null}
      {issues.length > 0 ? <Issues issues={issues} /> : null}

      <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardHeader eyebrow="Plugins" title={`${plugins.length} page(s)`} />
          <div className="max-h-[70vh] space-y-1 overflow-y-auto px-2 py-2">
            {loading ? <p className="px-2 py-3 text-sm text-slate-500">Loading plugins…</p> : null}
            {!loading && plugins.length === 0 ? (
              <EmptyState title="No plugins yet" message="Create a draft or import a portable bundle." />
            ) : null}
            {plugins.map((plugin) => (
              <button
                key={plugin.id}
                type="button"
                onClick={() => selectPlugin(plugin)}
                className={
                  draft?.id === plugin.id
                    ? 'w-full rounded-xl border border-sky-300 bg-sky-50 px-3 py-2 text-left dark:border-sky-900 dark:bg-sky-950/40'
                    : 'w-full rounded-xl border border-transparent px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-[#142136]'
                }
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{plugin.name}</span>
                  <Pill tone={plugin.status === 'published' ? 'ok' : 'neutral'}>{plugin.status}</Pill>
                </span>
                <span className="mt-0.5 block text-[11px] text-slate-500 dark:text-slate-400">
                  {plugin.audience} · v{plugin.version}
                  {plugin.publishedVersion !== undefined ? ` · published v${plugin.publishedVersion}` : ''}
                </span>
              </button>
            ))}
          </div>
        </Card>

        {draft ? (
          <div className="space-y-4">
            <Card>
              <CardHeader
                eyebrow={draft.id ? `Plugin ${draft.id}` : 'Unsaved new plugin'}
                title={draft.name || 'Untitled page'}
                description="Metadata, role audience and lifecycle. Changes are local until saved."
                actions={
                  <>
                    <Button variant="ghost" onClick={() => setPreview((value) => !value)}>
                      <Wand2 size={14} /> {preview ? 'Edit' : 'Preview'}
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => void save()}
                      disabled={Boolean(busy) || (!isDirty && Boolean(draft.id))}
                    >
                      <Save size={14} /> {busy === 'save' ? 'Saving…' : 'Save draft'}
                    </Button>
                    <Button
                      variant="ok"
                      onClick={() => void publish()}
                      disabled={Boolean(busy) || !draft.id || isDirty || allIssues.length > 0}
                    >
                      {busy === 'publish' ? 'Publishing…' : 'Publish'}
                    </Button>
                    {draft.id && draft.status === 'published' ? (
                      <Button variant="warn" onClick={() => void unpublish()} disabled={Boolean(busy)}>
                        {busy === 'unpublish' ? 'Working…' : 'Unpublish'}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      onClick={() => void exportBundle()}
                      disabled={Boolean(busy) || !draft.id || isDirty}
                      title={isDirty ? 'Save the draft before exporting it.' : undefined}
                    >
                      <Download size={14} /> Export draft
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => void buildForTier3()}
                      disabled={Boolean(busy) || !draft.id || isDirty || draft.status !== 'published'}
                      title={
                        isDirty
                          ? 'Save and publish the current draft before building a Tier-3 artifact.'
                          : draft.status === 'published'
                            ? `Builds the immutable published snapshot${draft.publishedVersion !== undefined ? ` (v${draft.publishedVersion})` : ''}. Publish again to include newer draft changes.`
                            : 'Publish the plugin before building a Tier-3 artifact.'
                      }
                    >
                      <Download size={14} /> {busy === 'build' ? 'Building…' : 'Build for Tier 3'}
                    </Button>
                  </>
                }
              />
              <div className="grid gap-3 px-5 py-4 lg:grid-cols-2">
                <Field label="Name" required>
                  <input
                    className={inputClassName}
                    value={draft.name}
                    maxLength={160}
                    onChange={(event) => patchDraft({ name: event.target.value })}
                  />
                </Field>
                <Field label="Slug" required help="Used in portable bundle filenames and repository sync.">
                  <input
                    className={inputClassName}
                    value={draft.slug}
                    maxLength={64}
                    onChange={(event) => patchDraft({ slug: event.target.value })}
                  />
                </Field>
                <Field label="Audience">
                  <select
                    className={selectClassName}
                    value={draft.audience}
                    onChange={(event) => patchDraft({ audience: event.target.value as 'admin' | 'member' })}
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </Field>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  <p>Product: <span className="font-mono">{draft.product}</span></p>
                  <p>Version: {draft.version}{draft.publishedVersion !== undefined ? ` · published ${draft.publishedVersion}` : ''}</p>
                  <p>Status: {draft.status}</p>
                </div>
              </div>
              <div className="border-t border-slate-100 px-5 py-3 dark:border-[#1f2c40]">
                <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">Audience roles</p>
                {roleOptions.length === 0 ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    The catalog did not advertise roles. Role updates stay server-validated.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {roleOptions.map((role) => (
                      <label
                        key={role}
                        className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 dark:border-[#26354d] dark:text-slate-200"
                      >
                        <input
                          type="checkbox"
                          checked={draft.roles.includes(role)}
                          onChange={(event) =>
                            patchDraft({
                              roles: event.target.checked
                                ? [...draft.roles, role]
                                : draft.roles.filter((item) => item !== role),
                            })
                          }
                        />
                        {role}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </Card>

            {preview ? (
              <Card>
                <CardHeader
                  eyebrow="Preview"
                  title="Page layout"
                  description="Structural preview. Metric/table data loads in /workspace after publish and install; forms stay disabled there unless the backend authorizes them."
                />
                <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
                  {draft.widgets.length === 0 ? (
                    <div className="sm:col-span-2">
                      <EmptyState title="No widgets" message="Add widgets from the palette." />
                    </div>
                  ) : (
                    draft.widgets.map((widget) => (
                      <SafeWidget key={widget.id} widget={widget} preview />
                    ))
                  )}
                </div>
              </Card>
            ) : (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                <Card>
                  <CardHeader eyebrow="Palette" title="Safe widgets" description="Only declarative widgets exist; no raw HTML, JS, SQL or URLs." />
                  <div className="space-y-3 px-5 py-4">
                    <div className="grid grid-cols-2 gap-2">
                      {(['text', 'metric', 'table', 'form'] as WorkspaceWidgetType[]).map((type) => {
                        const enabled = widgetTypes.includes(type);
                        return (
                          <Button
                            key={type}
                            variant={type === 'form' ? 'warn' : 'ghost'}
                            onClick={() => addWidget(type)}
                            disabled={!enabled}
                            title={!enabled ? `${WIDGET_LABELS[type]} is not advertised by this catalog` : undefined}
                          >
                            <Plus size={14} /> {WIDGET_LABELS[type]}
                          </Button>
                        );
                      })}
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Form widgets can be designed, but submission stays disabled unless the execution capability
                      authorizes it and a workflow artifact is bound.
                    </p>

                    <div className="border-t border-slate-100 pt-3 dark:border-[#1f2c40]">
                      <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                        Widgets ({draft.widgets.length})
                      </p>
                      {draft.widgets.length === 0 ? (
                        <p className="text-xs text-slate-500 dark:text-slate-400">Add your first widget.</p>
                      ) : (
                        <ul className="space-y-1">
                          {draft.widgets.map((widget, index) => (
                            <li
                              key={widget.id}
                              className={
                                widget.id === selectedWidgetId
                                  ? 'flex items-center gap-1 rounded-lg border border-sky-300 bg-sky-50 px-2 py-1.5 dark:border-sky-900 dark:bg-sky-950/40'
                                  : 'flex items-center gap-1 rounded-lg border border-transparent px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-[#142136]'
                              }
                            >
                              <GripVertical size={13} className="shrink-0 text-slate-400" aria-hidden="true" />
                              <button
                                type="button"
                                onClick={() => setSelectedWidgetId(widget.id)}
                                className="min-w-0 flex-1 truncate text-left text-xs font-medium text-slate-700 dark:text-slate-200"
                              >
                                {index + 1}. {widget.title}
                              </button>
                              <SmallButton
                                type="button"
                                aria-label="Move up"
                                onClick={() => moveWidget(index, index - 1)}
                                disabled={index === 0}
                              >
                                <ArrowUp size={12} />
                              </SmallButton>
                              <SmallButton
                                type="button"
                                aria-label="Move down"
                                onClick={() => moveWidget(index, index + 1)}
                                disabled={index === draft.widgets.length - 1}
                              >
                                <ArrowDown size={12} />
                              </SmallButton>
                              <SmallButton
                                type="button"
                                variant="danger"
                                aria-label={`Remove ${widget.title}`}
                                onClick={() => {
                                  const widgets = draft.widgets.filter((item) => item.id !== widget.id);
                                  patchDraft({ widgets });
                                  if (selectedWidgetId === widget.id) setSelectedWidgetId(widgets[0]?.id ?? null);
                                }}
                              >
                                <Trash2 size={12} />
                              </SmallButton>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </Card>

                <Card>
                  <CardHeader
                    eyebrow="Configuration"
                    title={selectedWidget ? selectedWidget.title : 'Select a widget'}
                    description="Widgets are declarative and bounded; unsafe fields are rejected before save."
                  />
                  <div className="px-5 py-4">
                    {selectedWidget ? (
                      <WidgetEditor
                        widget={selectedWidget}
                        index={selectedIndex}
                        resources={resources}
                        artifacts={artifactOptions}
                        artifactsError={artifactsQuery.error ? errorText(artifactsQuery.error) : null}
                        formExecutionReady={catalog?.workflowExecution?.ready ?? mutation.formExecution}
                        formExecutionRequirement={catalog?.workflowExecution?.requirement ?? mutation.reason}
                        actions={actionTypes}
                        orgReadiness={orgReadiness}
                        onChange={(patch) => patchWidget(selectedWidget.id, patch)}
                      />
                    ) : (
                      <EmptyState title="No widget selected" message="Add or select a widget to configure it." />
                    )}
                  </div>
                </Card>
              </div>
            )}
          </div>
        ) : (
          <Card className="flex items-center justify-center py-16">
            <EmptyState
              icon={<FileJson size={20} />}
              title="No plugin selected"
              message="Create a plugin or import a portable bundle to start designing a page."
              action={<Button variant="primary" onClick={() => setNewOpen(true)}><Plus size={14} /> New plugin</Button>}
            />
          </Card>
        )}
      </div>

      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New workspace plugin"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={createNew}>Create draft</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required>
            <input
              className={inputClassName}
              value={newName}
              maxLength={160}
              onChange={(event) => {
                setNewName(event.target.value);
                if (!newSlugTouched) setNewSlug(slugify(event.target.value));
              }}
            />
          </Field>
          <Field label="Slug" required>
            <input
              className={inputClassName}
              value={newSlug}
              maxLength={64}
              onChange={(event) => {
                setNewSlugTouched(true);
                setNewSlug(event.target.value);
              }}
            />
          </Field>
          <Field label="Audience">
            <select
              className={selectClassName}
              value={newAudience}
              onChange={(event) => setNewAudience(event.target.value as 'admin' | 'member')}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
        </div>
      </Modal>

      <Modal
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          setPendingBundle(null);
          setImportIssues([]);
          setImportError(null);
        }}
        title="Import portable bundle"
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void confirmImport()} disabled={!pendingBundle || Boolean(busy)}>
              {busy === 'import' ? 'Importing…' : 'Import as draft'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Imports create a DRAFT and never auto-install. Server state, tenant ids, tokens and membership are rejected.
          </p>
          <Issues issues={importIssues} max={12} />
          <ModalError message={importError} />
          {pendingBundle ? (
            <div className="rounded-xl border border-slate-200 p-3 text-sm dark:border-[#26354d]">
              <p className="font-semibold text-slate-900 dark:text-slate-100">{pendingBundle.plugin.name}</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {pendingBundle.plugin.product} · {pendingBundle.plugin.audience} ·{' '}
                {pendingBundle.plugin.widgets.length} widget(s) · roles:{' '}
                {pendingBundle.plugin.roles.join(', ') || 'none'}
              </p>
              {pendingBundle.source?.repository ? (
                <p className="mt-1 break-all text-xs text-slate-500 dark:text-slate-400">
                  source: {pendingBundle.source.repository}
                  {pendingBundle.source.path ? `/${pendingBundle.source.path}` : ''}
                </p>
              ) : null}
              {pendingBundle.checksum ? (
                <p className="mt-1 break-all font-mono text-[11px] text-slate-500 dark:text-slate-400">
                  {pendingBundle.checksum}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={buildArtifact !== null}
        onClose={() => setBuildArtifact(null)}
        title="Tier-3 build ready"
        eyebrow={buildArtifact ? `${buildArtifact.pluginName} · published v${buildArtifact.version}` : undefined}
        footer={<Button variant="primary" onClick={() => setBuildArtifact(null)}>Done</Button>}
      >
        {buildArtifact ? (
          <div className="space-y-3 text-sm">
            <p className="text-slate-600 dark:text-slate-300">
              The bundle was built from the immutable published snapshot. Commit it to the owning repository;
              the Tier-3 sync CLI validates the same checksum and provenance.
            </p>
            <dl className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-[#26354d]">
              <div>
                <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">Repository</dt>
                <dd className="break-all font-mono text-xs text-slate-800 dark:text-slate-200">{buildArtifact.repository}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">Tracked path</dt>
                <dd className="break-all font-mono text-xs text-slate-800 dark:text-slate-200">{buildArtifact.path}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">Checksum</dt>
                <dd className="break-all font-mono text-xs text-slate-800 dark:text-slate-200">{buildArtifact.checksum}</dd>
              </div>
            </dl>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Downloaded file: <span className="font-mono">{buildArtifact.filename}</span>. No secret, token,
              tenant id or environment-specific artifact id is included.
            </p>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
