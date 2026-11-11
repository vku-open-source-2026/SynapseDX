// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { CheckCircle2, AlertTriangle, XCircle, X } from 'lucide-react';
import { useToastStore } from '../stores/toastStore';

const ICONS = {
  ok: <CheckCircle2 size={16} className="text-emerald-500" />,
  warn: <AlertTriangle size={16} className="text-amber-500" />,
  bad: <XCircle size={16} className="text-red-500" />,
};

export function Toaster() {
  const { toasts, dismiss } = useToastStore();
  if (!toasts.length) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-5 right-5 z-[95] flex w-80 flex-col gap-2"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          className="pointer-events-auto flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 shadow-lg dark:border-[#1f2c40] dark:bg-[#142136] dark:text-slate-200"
        >
          <span className="mt-0.5 shrink-0">{ICONS[item.tone]}</span>
          <span className="min-w-0 flex-1">{item.message}</span>
          <button
            type="button"
            onClick={() => dismiss(item.id)}
            aria-label="Dismiss notification"
            className="shrink-0 rounded-md p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
