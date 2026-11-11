// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Small design system shared by the public catalog and the admin console. */
import React from 'react';
import { cn } from '../lib/utils';
import { Modal } from './Modal';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-[#1f2c40] dark:bg-[#101a2a] dark:shadow-none',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-[#1f2c40]">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {eyebrow}
          </p>
        ) : null}
        <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'ok' | 'warn';

const BUTTON_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'inline-flex items-center gap-2 whitespace-nowrap rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 disabled:cursor-not-allowed disabled:opacity-50',
  ghost:
    'inline-flex items-center gap-2 whitespace-nowrap rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-[#26354d] dark:bg-[#142136] dark:text-slate-200 dark:hover:bg-[#1a2840] disabled:cursor-not-allowed disabled:opacity-50',
  danger:
    'inline-flex items-center gap-2 whitespace-nowrap rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/40 disabled:cursor-not-allowed disabled:opacity-50',
  ok:
    'inline-flex items-center gap-2 whitespace-nowrap rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300 dark:hover:bg-emerald-950 disabled:cursor-not-allowed disabled:opacity-50',
  warn:
    'inline-flex items-center gap-2 whitespace-nowrap rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300 dark:hover:bg-amber-950 disabled:cursor-not-allowed disabled:opacity-50',
};

export function Button({
  variant = 'ghost',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button className={cn(BUTTON_CLASSES[variant], className)} {...props} />;
}

export function SmallButton({
  variant = 'ghost',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      className={cn(
        BUTTON_CLASSES[variant],
        'rounded-lg px-2.5 py-1.5 text-xs',
        className,
      )}
      {...props}
    />
  );
}

export type PillTone = 'ok' | 'warn' | 'bad' | 'neutral';

const PILL_CLASSES: Record<PillTone, string> = {
  ok: 'inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-900',
  warn:
    'inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-900',
  bad: 'inline-flex items-center rounded-full bg-red-50 px-2.5 py-0.5 text-[11px] font-semibold text-red-700 ring-1 ring-inset ring-red-200 dark:bg-red-950/60 dark:text-red-300 dark:ring-red-900',
  neutral:
    'inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
};

export function Pill({ tone = 'neutral', children }: { tone?: PillTone; children: React.ReactNode }) {
  return <span className={PILL_CLASSES[tone]}>{children}</span>;
}

export function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 font-mono text-[11px] text-slate-600 dark:border-[#26354d] dark:bg-[#142136] dark:text-slate-300">
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  message?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 px-6 py-12 text-center dark:border-[#2a3a52]">
      {icon ? <div className="text-slate-300 dark:text-slate-600">{icon}</div> : null}
      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</p>
      {message ? <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">{message}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-slate-200/70 dark:bg-[#1a2840]', className)} aria-hidden="true" />;
}

export function TableShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-[#1f2c40]">{children}</table>
    </div>
  );
}

export function Thead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="bg-slate-50 dark:bg-[#142136]">
      <tr>{children}</tr>
    </thead>
  );
}

export function Th({ children, className, ...rest }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'whitespace-nowrap px-4 py-2.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({ children, className, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('px-4 py-3 align-middle text-slate-700 dark:text-slate-300', className)} {...rest}>
      {children}
    </td>
  );
}

export function Tr({ children, className }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('border-b border-slate-100 last:border-0 hover:bg-slate-50/60 dark:border-[#1f2c40] dark:hover:bg-[#142136]', className)}>{children}</tr>;
}

export const inputClassName =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-[#26354d] dark:bg-[#0d1626] dark:text-slate-100 dark:placeholder-slate-500 dark:focus:border-sky-500';

export const selectClassName = inputClassName;

/** Confirmation dialog driven by local page state. */
export function ConfirmDialog({
  open,
  title,
  message,
  label = 'Confirm',
  danger,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message?: string;
  label?: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : label}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-slate-600">{message}</p>
    </Modal>
  );
}

/** Simple disclosure-style action menu for table rows. */
export function ActionMenu({ children }: { children: React.ReactNode }) {
  return (
    <details className="relative inline-block">
      <summary
        className="cursor-pointer list-none rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 dark:border-[#26354d] dark:bg-[#142136] dark:text-slate-200 dark:hover:bg-[#1a2840] [&::-webkit-details-marker]:hidden"
      >
        Actions
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-44 rounded-xl border border-slate-200 bg-white p-1 shadow-xl dark:border-[#26354d] dark:bg-[#142136]">
        {children}
      </div>
    </details>
  );
}

/** Full-width action item for ActionMenu. */
export function MenuButton({
  variant = 'ghost',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'ghost' | 'danger' | 'ok' | 'warn' | 'primary' }) {
  const tone =
    variant === 'danger' ? 'text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/50' : variant === 'ok' ? 'text-emerald-800 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950/50' : variant === 'warn' ? 'text-amber-800 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/50' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-[#1a2840]';
  return (
    <button
      type="button"
      className={cn(
        'block w-full rounded-lg px-2.5 py-1.5 text-left text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50',
        tone,
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
      <span className="flex items-center gap-1">
        {label}
        {required ? <span className="text-red-500">*</span> : null}
      </span>
      <div className="mt-1.5">{children}</div>
      {help ? <small className="mt-1 block text-xs font-normal text-slate-500 dark:text-slate-400">{help}</small> : null}
    </label>
  );
}

export function KpiCard({
  label,
  value,
  icon,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  hint?: string;
}) {
  return (
    <Card className="flex items-center gap-4 p-5">
      {icon ? (
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-md shadow-sky-500/25">
          {icon}
        </div>
      ) : null}
      <div className="min-w-0">
        <p className="whitespace-nowrap text-sm font-medium text-slate-500 dark:text-slate-400">{label}</p>
        <p className="mt-0.5 truncate text-2xl font-semibold tracking-tight text-slate-900 tabular-nums dark:text-slate-100">{value}</p>
        {hint ? <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
      </div>
    </Card>
  );
}
