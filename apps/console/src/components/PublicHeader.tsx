// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useState } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { LogIn, Menu, X } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../lib/i18n-context';
import type { Messages } from '../locales/vi';
import { cn } from '../lib/utils';
import { BrandMark } from './BrandMark';
import { SiteToggles } from './SiteToggles';
import { StableLabel } from './StableLabel';

const LINKS: Array<{ to: string; pick: (m: Messages) => string; external?: boolean }> = [
  { to: '/', pick: (m) => m.nav.home },
  { to: '/about', pick: (m) => m.nav.about },
  { to: '/docs', pick: (m) => m.nav.apiDocs },
];

const NAV_LINK = 'rounded-lg px-3 py-1.5 text-sm transition-colors hover:text-dx-fg';

/** Public top navigation shared by Home, About and the sign-in page. */
export function PublicHeader() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const session = useAuthStore((state) => state.session);
  const { m } = useI18n();
  const authTo = session ? '/admin' : '/login';
  // Desktop labels reserve the width of the longest translation so a language switch never shifts the buttons.
  const pickAuth = (d: Messages) => (session ? d.nav.console : d.nav.signIn);

  return (
    <header className="sticky top-0 z-50 border-b border-dx-line bg-dx-surface/95 backdrop-blur supports-[backdrop-filter]:bg-dx-surface/85">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link to="/" aria-label="SynapseDX" onClick={() => setOpen(false)}>
          <BrandMark />
        </Link>
        <nav className="hidden items-center gap-1 md:flex" aria-label="SynapseDX">
          {LINKS.map((link) =>
            link.external ? (
              <a key={link.to} href={link.to} target="_blank" rel="noreferrer" className={cn(NAV_LINK, 'text-dx-muted')}>
                <StableLabel pick={link.pick} />
              </a>
            ) : (
              <Link
                key={link.to}
                to={link.to}
                aria-current={pathname === link.to ? 'page' : undefined}
                className={cn(NAV_LINK, pathname === link.to ? 'font-medium text-dx-fg' : 'text-dx-muted')}
              >
                <StableLabel pick={link.pick} />
              </Link>
            ),
          )}
          <SiteToggles className="ml-1" />
          <Link
            to={authTo}
            className="ml-2 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 px-4 py-1.5 text-sm font-semibold text-white transition hover:brightness-110"
          >
            <LogIn size={16} aria-hidden="true" />
            <StableLabel pick={pickAuth} />
          </Link>
        </nav>
        <div className="flex items-center gap-1 md:hidden">
          <SiteToggles />
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? m.nav.closeMenu : m.nav.openMenu}
            aria-expanded={open}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-dx-muted hover:text-dx-fg"
          >
            {open ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
          </button>
        </div>
      </div>
      {open ? (
        <div className="border-t border-dx-line bg-dx-surface px-4 py-2 shadow-md md:hidden">
          {LINKS.map((link) =>
            link.external ? (
              <a key={link.to} href={link.to} target="_blank" rel="noreferrer" className="block py-2.5 text-sm text-dx-fg">
                {link.pick(m)}
              </a>
            ) : (
              <Link key={link.to} to={link.to} onClick={() => setOpen(false)} className="block py-2.5 text-sm text-dx-fg">
                {link.pick(m)}
              </Link>
            ),
          )}
          <Link to={authTo} onClick={() => setOpen(false)} className="block py-2.5 text-sm font-semibold text-dx-accent">
            {session ? m.nav.openConsole : m.nav.signIn}
          </Link>
        </div>
      ) : null}
    </header>
  );
}
