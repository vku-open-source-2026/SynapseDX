// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useI18n } from '../lib/i18n-context';
import { cn } from '../lib/utils';

/**
 * SynapseDX app-icon tile + wordmark.
 * The tile carries the arch mark on a deep-sky field; `onDark` switches the text colours
 * for the console sidebar.
 */
export function BrandMark({ onDark, compact }: { onDark?: boolean; compact?: boolean }) {
  const { m } = useI18n();
  return (
    <span className="flex items-center gap-2.5">
      <svg viewBox="0 0 256 256" className="h-9 w-9 shrink-0" aria-hidden="true">
        <rect width="256" height="256" rx="56" fill="#075985" />
        <g transform="translate(51.2 51.2) scale(0.6)">
          <path
            fill="#FFFFFF"
            d="M 24 216 L 24 144 A 104 104 0 0 1 110 41.6 L 110 91 A 56 56 0 0 0 80 144 L 80 216 Z"
          />
          <path
            fill="#FFFFFF"
            d="M 232 216 L 232 144 A 104 104 0 0 0 146 41.6 L 146 91 A 56 56 0 0 1 176 144 L 176 216 Z"
          />
        </g>
      </svg>
      <span className="leading-tight">
        <span className={cn('block text-[17px] font-semibold tracking-tight', onDark ? 'text-white' : 'text-dx-fg')}>
          Synapse<span className={onDark ? 'text-sky-300' : 'text-sky-700'}>DX</span>
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
