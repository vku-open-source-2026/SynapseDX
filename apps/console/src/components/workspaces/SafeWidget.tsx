// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * The only renderer for declarative workspace widgets. Text is always a React
 * text node (never HTML), tables only read declared columns and forms submit
 * only when the backend advertises validated write support.
 */
import { useId, useState, type FormEvent } from 'react';import { BarChart3, Table2, Type as TypeIcon, ClipboardList, Send } from 'lucide-react';
import { Button, Card, EmptyState, Pill, Skeleton, inputClassName } from '../ui';
import { formatNumber } from '../../lib/format';
import {
  formDisabledReason,
  isFormWritable,
  safeCellText,
  type RuntimeWidget,
  type WidgetData,
  type WorkspaceFormAction,
} from '../../lib/workspaces';
import { cn } from '../../lib/utils';

export interface SafeWidgetProps {
  widget: RuntimeWidget;
  data?: WidgetData;
  dataLoading?: boolean;
  dataError?: string | null;
  preview?: boolean;
  formUnavailableReason?: string | null;
  onFormSubmit?: (values: Record<string, unknown>) => Promise<void>;
  formBusy?: boolean;
}

const ICONS: Record<RuntimeWidget['type'], typeof TypeIcon> = {
  text: TypeIcon,
  metric: BarChart3,
  table: Table2,
  form: ClipboardList,
};

const ACTION_LABELS: Record<WorkspaceFormAction, string> = {
  create: 'Submit',
  update: 'Submit update',
  delete: 'Request deletion',
  execute: 'Run action',
};

function WidgetShell({
  widget,
  children,
  footer,
}: {
  widget: RuntimeWidget;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const Icon = ICONS[widget.type];
  return (
    <Card className={cn('flex h-full flex-col p-4', widget.width === 'full' ? 'sm:col-span-2' : '')}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <Icon size={16} className="shrink-0 text-sky-600 dark:text-sky-400" aria-hidden="true" />
          <span className="truncate">{widget.title}</span>
        </h3>
        <Pill tone="neutral">{widget.type}</Pill>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
      {footer ? <div className="mt-3 text-[11px] text-slate-500 dark:text-slate-400">{footer}</div> : null}
    </Card>
  );
}

function WidgetFeedback({ message, tone = 'neutral' }: { message: string; tone?: 'neutral' | 'bad' }) {
  return (
    <p
      className={cn(
        'rounded-lg px-3 py-2 text-xs leading-5',
        tone === 'bad'
          ? 'border border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300'
          : 'border border-slate-200 bg-slate-50 text-slate-600 dark:border-[#26354d] dark:bg-[#142136] dark:text-slate-300',
      )}
    >
      {message}
    </p>
  );
}

function TextWidget({ widget }: { widget: RuntimeWidget }) {
  if (!widget.text) {
    return <p className="text-sm italic text-slate-400 dark:text-slate-500">This text widget has no content yet.</p>;
  }
  return <p className="whitespace-pre-line break-words text-sm leading-6 text-slate-700 dark:text-slate-300">{widget.text}</p>;
}

function MetricWidget({
  widget,
  data,
  loading,
  error,
  preview,
}: {
  widget: RuntimeWidget;
  data?: WidgetData;
  loading?: boolean;
  error?: string | null;
  preview?: boolean;
}) {
  if (preview) {
    return (
      <div className="space-y-2">
        <p className="text-3xl font-semibold tracking-tight text-slate-300 dark:text-slate-600">—</p>
        <WidgetFeedback message="The live count loads in /workspace after this page is published and installed." />
      </div>
    );
  }
  if (loading) return <Skeleton className="h-14 w-32" />;
  if (error) return <WidgetFeedback tone="bad" message={`Data unavailable: ${error}`} />;
  return (
    <div>
      <p className="text-3xl font-semibold tracking-tight text-slate-900 tabular-nums dark:text-slate-100">
        {formatNumber(data?.total ?? 0)}
      </p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        records returned by <span className="font-mono">{widget.resource || 'the catalog resource'}</span>
      </p>
    </div>
  );
}

function TableWidget({
  widget,
  data,
  loading,
  error,
  preview,
}: {
  widget: RuntimeWidget;
  data?: WidgetData;
  loading?: boolean;
  error?: string | null;
  preview?: boolean;
}) {
  if (preview) {
    return (
      <div className="space-y-2">
        <WidgetFeedback message="Rows load in /workspace after this page is published and installed." />
        {widget.columns?.length ? (
          <div className="flex flex-wrap gap-1">
            {widget.columns.map((column) => (
              <span
                key={column}
                className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                {column}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (loading) return <Skeleton className="h-28 w-full" />;
  if (error) return <WidgetFeedback tone="bad" message={`Data unavailable: ${error}`} />;

  const columns = (widget.columns?.length ? widget.columns : data?.columns ?? []).slice(0, 20);
  const rows = data?.rows ?? [];
  if (columns.length === 0) {
    return <EmptyState title="No columns" message="The backend did not return displayable columns for this resource." />;
  }
  if (rows.length === 0) {
    return <EmptyState title="No rows" message="The resource returned no records for your role." />;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-[#26354d]">
      <table className="min-w-full text-left text-xs">
        <thead className="bg-slate-50 text-slate-500 dark:bg-[#142136] dark:text-slate-400">
          <tr>
            {columns.map((column) => (
              <th key={column} className="whitespace-nowrap px-3 py-2 font-semibold">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-[#1f2c40]">
          {rows.slice(0, 50).map((row, index) => (
            <tr key={index} className="text-slate-700 dark:text-slate-200">
              {columns.map((column) => (
                <td key={column} className="max-w-[18rem] truncate px-3 py-2 font-mono" title={safeCellText(row[column])}>
                  {safeCellText(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500 dark:border-[#1f2c40] dark:text-slate-400">
        Showing {Math.min(rows.length, 50)} of {formatNumber(data?.total ?? rows.length)} record(s)
      </p>
    </div>
  );
}

function FormWidget({
  widget,
  preview,
  unavailableReason,
  onSubmit,
  busy,
}: {
  widget: RuntimeWidget;
  preview?: boolean;
  unavailableReason?: string | null;
  onSubmit?: (values: Record<string, unknown>) => Promise<void>;
  busy?: boolean;
}) {
  const prefix = useId();
  const fields = widget.fields ?? [];
  const writable = isFormWritable(widget);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabledReason = formDisabledReason(widget);
  const disabled = !writable || preview || !onSubmit || Boolean(busy);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || submitting) return;
    setError(null);
    setSaved(false);

    const payload: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = (values[field.name] ?? '').trim();
      if (field.required && !raw) {
        setError(`${field.label} is required.`);
        return;
      }
      if (!raw) continue;
      if (field.type === 'number') {
        const number = Number(raw);
        if (!Number.isFinite(number)) {
          setError(`${field.label} must be a number.`);
          return;
        }
        payload[field.name] = number;
      } else {
        payload[field.name] = raw;
      }
    }

    setSubmitting(true);
    try {
      await onSubmit?.(payload);
      setSaved(true);
    } catch (failure) {
      setError((failure as Error)?.message || 'The record could not be created.');
    } finally {
      setSubmitting(false);
    }
  };

  if (fields.length === 0) {
    return <WidgetFeedback message="This form has no fields. Edit the draft in the builder." />;
  }

  const statusMessage = preview
    ? 'Preview only. The form submits in /workspace after the page is published and installed, and only when the backend authorizes the action.'
    : !writable
      ? unavailableReason || disabledReason || 'This form is read-only.'
      : disabled
        ? 'This form cannot submit in this environment.'
        : null;

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      {statusMessage ? (
        <WidgetFeedback tone={!preview && !writable ? 'bad' : 'neutral'} message={statusMessage} />
      ) : null}
      <fieldset disabled={disabled || submitting} className="space-y-3 disabled:opacity-60">
        {fields.map((field) => {
          const id = `${prefix}-${field.name}`;
          const setValue = (next: string) => {
            setValues((current) => ({ ...current, [field.name]: next }));
            setSaved(false);
          };
          return (
            <label key={field.name} htmlFor={id} className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              <span>
                {field.label}
                {field.required ? <span className="ml-0.5 text-red-500">*</span> : null}
              </span>
              <div className="mt-1.5">
                {field.type === 'textarea' ? (
                  <textarea
                    id={id}
                    name={field.name}
                    value={values[field.name] ?? ''}
                    onChange={(event) => setValue(event.target.value)}
                    className={inputClassName}
                    rows={3}
                    maxLength={8000}
                    required={field.required}
                  />
                ) : field.type === 'number' ? (
                  <input
                    id={id}
                    name={field.name}
                    value={values[field.name] ?? ''}
                    onChange={(event) => setValue(event.target.value)}
                    className={inputClassName}
                    type="number"
                    step="any"
                    inputMode="decimal"
                    required={field.required}
                  />
                ) : (
                  <input
                    id={id}
                    name={field.name}
                    value={values[field.name] ?? ''}
                    onChange={(event) => setValue(event.target.value)}
                    className={inputClassName}
                    type="text"
                    maxLength={2000}
                    required={field.required}
                  />
                )}
              </div>
            </label>
          );
        })}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={disabled || submitting}>
          <Send size={14} /> {submitting ? 'Submitting…' : saved ? 'Submit again' : ACTION_LABELS[widget.action ?? 'create']}
        </Button>
        {saved ? (
          <span role="status" className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
            Submitted. The bound workflow execution was accepted by Tier 1.
          </span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function SafeWidget({
  widget,
  data,
  dataLoading,
  dataError,
  preview,
  formUnavailableReason,
  onFormSubmit,
  formBusy,
}: SafeWidgetProps) {
  return (
    <WidgetShell
      widget={widget}
      footer={
        widget.type === 'metric' || widget.type === 'table'
          ? `resource: ${widget.resource ?? '—'}`
          : widget.type === 'form'
            ? `declared action: ${widget.action ?? 'create'}`
            : undefined
      }
    >
      {widget.type === 'text' ? <TextWidget widget={widget} /> : null}
      {widget.type === 'metric' ? (
        <MetricWidget widget={widget} data={data} loading={dataLoading} error={dataError} preview={preview} />
      ) : null}
      {widget.type === 'table' ? (
        <TableWidget widget={widget} data={data} loading={dataLoading} error={dataError} preview={preview} />
      ) : null}
      {widget.type === 'form' ? (
        <FormWidget
          widget={widget}
          preview={preview}
          unavailableReason={formUnavailableReason}
          onSubmit={onFormSubmit}
          busy={formBusy}
        />
      ) : null}
    </WidgetShell>
  );
}
