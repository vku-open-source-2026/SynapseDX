// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Boxes } from 'lucide-react';
import { useI18n } from '../lib/i18n-context';
import { cn } from '../lib/utils';

/** SynapseDX logo tile + wordmark. `onDark` switches the text colours for the console sidebar. */
export function BrandMark({ onDark, compact }: { onDark?: boolean; compact?: boolean }) {
  const { m } = useI18n();
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-sm shadow-blue-900/20">
        <Boxes size={19} strokeWidth={2.1} aria-hidden="true" />
      </span>
      <span className="leading-tight">
        <span className={cn('block text-[17px] font-semibold tracking-tight', onDark ? 'text-white' : 'text-dx-fg')}>
          SynapseDX
        </span>
        {compact ? null : (
          <span className={cn('block whitespace-nowrap text-[11px] font-medium', onDark ? 'text-slate-400' : 'text-dx-muted')}>
            {m.brand.sub}
          </span>
        )}
      </span>
    </span>
  );
}
