// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useI18n } from '../lib/i18n-context';

/** Console footer: product, licence and the last health-check stamp. */
export function Footer({ checkedAt }: { checkedAt?: Date }) {
  const { m, lang } = useI18n();
  const at = checkedAt ?? new Date();
  return (
    <footer className="border-t border-dx-line bg-dx-surface px-5 py-3 text-xs text-dx-muted">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-2">
        <span>SynapseDX · {m.shell.footer}</span>
        <span>
          {m.shell.checked}{' '}
          <time dateTime={at.toISOString()}>{at.toLocaleTimeString(lang === 'vi' ? 'vi-VN' : 'en-GB')}</time>
          {' · '}
          <a className="underline underline-offset-2 hover:text-dx-fg" href="/health" target="_blank" rel="noreferrer">
            /health
          </a>
        </span>
      </div>
    </footer>
  );
}
