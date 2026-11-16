// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useI18n } from '../lib/i18n-context';
import type { Messages } from '../locales/vi';
import { cn } from '../lib/utils';

/**
 * Text whose box is as wide as its longest translation, so switching VI/EN
 * never moves neighbouring buttons under the pointer.
 */
export function StableLabel({ pick, className }: { pick: (m: Messages) => string; className?: string }) {
  const { m, dicts } = useI18n();
  return (
    <span className={cn('inline-grid whitespace-nowrap', className)}>
      {Object.entries(dicts).map(([lang, dict]) => (
        <span key={lang} aria-hidden="true" className="invisible col-start-1 row-start-1">
          {pick(dict)}
        </span>
      ))}
      <span className="col-start-1 row-start-1 text-center">{pick(m)}</span>
    </span>
  );
}
