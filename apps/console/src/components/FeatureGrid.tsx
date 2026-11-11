// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import type { LucideIcon } from 'lucide-react';
import { cn } from '../lib/utils';
import { CARD_HOVER, ICON_TILE } from './public-styles';

/**
 * Numbered feature cards (gradient icon tile, faded 01..n), the same card
 * family SynapseOne uses on Home and About. `icons[i]` belongs to `items[i]`;
 * `proof[i]` is an optional mono line naming where the feature lives.
 */
export function FeatureGrid({
  items,
  icons,
  proof,
  columns = 3,
}: {
  items: Array<{ title: string; text: string }>;
  icons: LucideIcon[];
  proof?: string[];
  columns?: 3 | 4;
}) {
  return (
    <ul className={cn('mt-6 grid gap-5 sm:grid-cols-2', columns === 4 ? 'xl:grid-cols-4' : 'lg:grid-cols-3')}>
      {items.map((item, index) => {
        const Icon = icons[index];
        return (
          <li
            key={item.title}
            className={cn('group relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-dx-line bg-dx-surface p-7', CARD_HOVER)}
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-5 top-2 select-none font-mono text-6xl font-bold text-sky-100 transition group-hover:text-sky-200 dark:text-sky-950 dark:group-hover:text-sky-900"
            >
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className={cn('relative', ICON_TILE)}>
              {Icon ? <Icon size={24} strokeWidth={1.75} aria-hidden="true" /> : null}
            </span>
            <h3 className="relative mt-6 text-lg font-semibold text-balance text-dx-fg">{item.title}</h3>
            <p className="relative mt-2 text-sm leading-relaxed text-dx-muted">{item.text}</p>
            {proof?.[index] ? (
              <p className="relative mt-auto pt-5 font-mono text-[11px] text-dx-accent">{proof[index]}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
