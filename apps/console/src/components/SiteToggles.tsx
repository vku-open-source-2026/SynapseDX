// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Monitor, Moon, Sun } from 'lucide-react';
import { useI18n } from '../lib/i18n-context';
import { useTheme } from '../lib/theme-context';
import { cn } from '../lib/utils';

// Same buttons and icons as the SynapseOne and SynapseCity headers.
const LIGHT_BTN =
  'flex h-9 w-9 items-center justify-center rounded-lg text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white';
const DARK_BTN =
  'flex h-9 w-9 items-center justify-center rounded-lg text-sm font-semibold text-slate-400 transition-colors hover:bg-slate-800 hover:text-white';

/** Language (VI/EN) and theme (light/dark/system) switches. `onDark` is for the always-dark sidebar. */
export function SiteToggles({ className, onDark }: { className?: string; onDark?: boolean }) {
  const { m, toggle } = useI18n();
  const { choice, cycle } = useTheme();
  const ThemeIcon = choice === 'dark' ? Moon : choice === 'light' ? Sun : Monitor;
  const themeLabel = m.nav.theme[choice];
  const btn = onDark ? DARK_BTN : LIGHT_BTN;
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <button type="button" onClick={toggle} title={m.nav.switchLang} aria-label={m.nav.switchLang} className={btn}>
        {m.nav.langShort}
      </button>
      <button type="button" onClick={cycle} title={themeLabel} aria-label={themeLabel} className={btn}>
        <ThemeIcon size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
