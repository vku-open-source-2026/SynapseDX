// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Link } from '@tanstack/react-router';
import { useI18n } from '../lib/i18n-context';
import { API_DOCS, HEALTH, REPO, SDK, SELF_HOST } from '../lib/site';
import { BrandMark } from './BrandMark';

// py-1 gives each link a finger-sized tap area on phones without changing the look.
const LINK = 'inline-block py-1 text-sm text-dx-muted transition-colors hover:text-dx-accent';

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-dx-fg">{title}</h3>
      <ul className="mt-2 space-y-0.5">
        {React.Children.map(children, (child) => (
          <li>{child}</li>
        ))}
      </ul>
    </div>
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK}>
      {children}
    </a>
  );
}

/** Footer shared by the public pages (same columns as the other Synapse sites). */
export function PublicFooter() {
  const { m } = useI18n();
  const f = m.footer;
  const l = f.links;
  return (
    <footer className="border-t border-dx-line bg-dx-surface">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[1.3fr_1fr_1fr_1fr_1fr]">
        <div className="col-span-2 lg:col-span-1">
          <Link to="/" aria-label="SynapseDX">
            <BrandMark compact />
          </Link>
          <p className="mt-3 max-w-xs text-sm text-dx-muted">{f.tagline}</p>
        </div>
        <Column title={f.product}>
          <Link to="/admin" className={LINK}>{l.console}</Link>
          <Ext href={API_DOCS}>{l.apiDocs}</Ext>
          <Link to="/about" className={LINK}>{l.about}</Link>
          <a href={HEALTH} className={LINK}>{l.health}</a>
        </Column>
        <Column title={f.project}>
          <Ext href={REPO}>{l.repo}</Ext>
          <Ext href={`${REPO}/releases`}>{l.releases}</Ext>
          <Ext href={`${REPO}/blob/main/CHANGELOG.md`}>{l.changelog}</Ext>
          <Ext href={SDK}>{l.sdk}</Ext>
        </Column>
        <Column title={f.support}>
          <Ext href={SELF_HOST}>{l.selfHost}</Ext>
          <Ext href={`${REPO}/issues`}>{l.issues}</Ext>
          <Ext href={`${REPO}/blob/main/CONTRIBUTING.md`}>{l.contributing}</Ext>
        </Column>
        <Column title={f.licenses}>
          <Ext href={`${REPO}/blob/main/LICENSE`}>{l.source}</Ext>
          <Ext href={`${REPO}/blob/main/THIRD-PARTY.md`}>{l.thirdParty}</Ext>
        </Column>
      </div>
      <div className="border-t border-dx-line">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-dx-muted sm:px-6">{f.bottom}</p>
      </div>
    </footer>
  );
}
