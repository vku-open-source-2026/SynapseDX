// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useState } from 'react';
import {
  ArrowRight,
  ArrowDown,
  ArrowUpRight,
  BookOpen,
  Boxes,
  BrainCircuit,
  Building2,
  Container,
  Database,
  GitBranch,
  Package,
  Scale,
  Server,
  Siren,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { PublicHeader } from '../components/PublicHeader';
import { PublicFooter } from '../components/PublicFooter';
import { FeatureGrid } from '../components/FeatureGrid';
import { CARD_HOVER, H2 } from '../components/public-styles';
import { useI18n } from '../lib/i18n-context';
import { API_DOCS, IMAGES, REPO, SDK, SELF_HOST, SITES } from '../lib/site';
import { cn } from '../lib/utils';

// Same order as `about.hpdi` in src/locales; the mono line names the console lanes behind each group.
const HPDI_ICONS: LucideIcon[] = [Users, Workflow, Database, BrainCircuit];
const HPDI_PROOF = ['inbox · workspace · people · approvals', 'projects · forms · moderation', 'datasets · records · events · quality', 'ocr · assistant · agents'];

// Each link shows the host it opens, so readers know where they are going.
const LINKS: Array<{ key: 'repo' | 'api' | 'selfHost' | 'sdk' | 'images' | 'license'; icon: LucideIcon; host: string; href: string }> = [
  { key: 'repo', icon: GitBranch, host: 'github.com', href: REPO },
  { key: 'api', icon: BookOpen, host: 'github.com', href: API_DOCS },
  { key: 'selfHost', icon: Server, host: 'github.com', href: SELF_HOST },
  { key: 'sdk', icon: Package, host: 'github.com', href: SDK },
  { key: 'images', icon: Container, host: 'ghcr.io', href: IMAGES },
  { key: 'license', icon: Scale, host: 'github.com', href: `${REPO}/blob/main/LICENSE` },
];

// Team order as on the other Synapse sites.
const TEAM: Array<{ name: string; avatar?: string }> = [
  { name: 'Hồ Sỹ Bảo Nhân', avatar: '/avatars/nhan.jpg' },
  { name: 'Võ Thành Nam' },
  { name: 'Trần Thị Thùy Dương', avatar: '/avatars/duong.jpg' },
];

const PARTNERS: Array<{ key: 'vku' | 'vic'; href: string; logo: string }> = [
  { key: 'vku', href: 'https://vku.udn.vn', logo: '/vku-logo.svg' },
  { key: 'vic', href: 'https://www.facebook.com/vic.club.vku?locale=vi_VN', logo: '/vic-logo.svg' },
];

function Avatar({ member }: { member: { name: string; avatar?: string } }) {
  const [failed, setFailed] = useState(false);
  if (member.avatar && !failed) {
    return (
      <img
        src={member.avatar}
        alt=""
        onError={() => setFailed(true)}
        className="h-24 w-24 shrink-0 rounded-full object-cover ring-4 ring-sky-100 dark:ring-sky-900"
      />
    );
  }
  // No photo: the given name's initial.
  return (
    <span className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-100 to-blue-200 text-3xl font-semibold text-sky-700 ring-4 ring-sky-100 dark:from-sky-900 dark:to-blue-900 dark:text-sky-200 dark:ring-sky-900">
      {member.name.split(' ').pop()?.charAt(0)}
    </span>
  );
}

/** One product card in the tier stack. */
function TierCard({
  icon: Icon,
  name,
  host,
  href,
  text,
  here,
  hereLabel,
}: {
  icon: LucideIcon;
  name: string;
  host: string;
  href?: string;
  text: string;
  here?: boolean;
  hereLabel?: string;
}) {
  const body = (
    <>
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-md shadow-sky-500/25">
          <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 font-semibold text-dx-fg">
            {name}
            {here ? (
              <span className="rounded-full bg-dx-accent-soft px-2 py-0.5 text-[11px] font-medium text-dx-accent">{hereLabel}</span>
            ) : null}
          </p>
          <p className="font-mono text-xs text-dx-muted">{host}</p>
        </div>
        {href ? <ArrowUpRight size={16} className="shrink-0 text-dx-muted" aria-hidden="true" /> : null}
      </div>
      <p className="mt-3 text-sm leading-relaxed text-dx-muted">{text}</p>
    </>
  );
  const cls = cn(
    'block min-w-0 rounded-2xl border bg-dx-surface p-5',
    here ? 'border-sky-300 shadow-lg shadow-sky-500/10 dark:border-sky-700' : 'border-dx-line',
    href && CARD_HOVER,
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={cls}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function StackArrow({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center py-2" aria-hidden="true">
      <span className="rounded-full border border-dx-line bg-dx-surface px-2.5 py-0.5 font-mono text-[11px] text-dx-muted">{label}</span>
      <ArrowDown size={16} className="mt-1 text-dx-muted" />
    </div>
  );
}

export function AboutPage() {
  const { m } = useI18n();
  const a = m.about;
  const t = a.tiers;
  return (
    <div className="flex min-h-full flex-col bg-dx-bg text-dx-fg">
      <PublicHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-20 pt-14 sm:px-6 lg:pt-20">
        <header className="max-w-3xl">
          <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-balance sm:text-5xl">{a.title}</h1>
          <p className="mt-5 text-lg leading-relaxed text-dx-muted text-pretty">{a.intro}</p>
        </header>

        {/* Why: the problem, then the answer. */}
        <section className="mt-20">
          <h2 className={H2}>{a.whyTitle}</h2>
          <div className="mt-6 grid gap-6 md:grid-cols-[1fr_auto_1fr] md:items-stretch md:gap-8">
            <div className="min-w-0 rounded-2xl border border-dx-line bg-dx-surface p-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-dx-muted">{a.whyProblem}</p>
              <p className="mt-3 leading-relaxed text-dx-fg">{a.why[0]}</p>
            </div>
            <div className="flex items-center justify-center" aria-hidden="true">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-md shadow-sky-500/25">
                <ArrowRight size={20} className="rotate-90 md:rotate-0" />
              </span>
            </div>
            <div className="min-w-0 rounded-2xl border border-sky-300 bg-dx-surface p-6 shadow-lg shadow-sky-500/10 dark:border-sky-700">
              <p className="text-xs font-semibold uppercase tracking-wider text-dx-accent">{a.whyAnswer}</p>
              <p className="mt-3 leading-relaxed text-dx-fg">{a.why[1]}</p>
            </div>
          </div>
        </section>

        {/* H-P-D-I: same card family as the Home features, plus the console lanes behind each group. */}
        <section className="mt-20">
          <h2 className={H2}>{a.hpdiTitle}</h2>
          <p className="mt-2 max-w-2xl text-dx-muted">{a.hpdiLead}</p>
          <FeatureGrid items={a.hpdi} icons={HPDI_ICONS} proof={HPDI_PROOF} columns={4} />
        </section>

        {/* Tier stack: where SynapseDX sits between the products and the platform. */}
        <section className="mt-20">
          <h2 className={H2}>{a.stackTitle}</h2>
          <p className="mt-2 max-w-2xl text-dx-muted">{a.stackLead}</p>
          <div className="mt-8">
            <p className="mb-2 text-sm font-medium text-dx-muted">{t.t3}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <TierCard icon={Building2} name="SynapseCity" host="synapsecity.sbs" href={SITES.city} text={t.city} />
              <TierCard icon={Siren} name="SynapseCitySOS" host="sos.synapsecity.sbs" href={SITES.sos} text={t.sos} />
            </div>
            <StackArrow label="@synapsedx/capabilities · HTTPS" />
            <p className="mb-2 text-sm font-medium text-dx-muted">{t.t2}</p>
            <TierCard icon={Boxes} name="SynapseDX" host="synapsedx.sbs" text={t.dx} here hereLabel={t.here} />
            <StackArrow label="@synapseone/sdk" />
            <p className="mb-2 text-sm font-medium text-dx-muted">{t.t1}</p>
            <TierCard icon={Server} name="SynapseOne" host="api.synapseone.space" href={SITES.one} text={t.one} />
          </div>
        </section>

        {/* Open-source links beside the release timeline. */}
        <section className="mt-20 grid gap-12 lg:grid-cols-2">
          <div className="min-w-0">
            <h2 className={H2}>{a.openSourceTitle}</h2>
            <p className="mt-3 leading-relaxed text-dx-muted">{a.openSourceText}</p>
            <ul className="mt-6 divide-y divide-dx-line border-y border-dx-line">
              {LINKS.map((link) => {
                const Icon = link.icon;
                return (
                  <li key={link.key}>
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noreferrer"
                      className="group flex items-center gap-3 py-3 text-sm transition hover:text-dx-accent"
                    >
                      <Icon size={16} className="shrink-0 text-dx-muted transition group-hover:text-dx-accent" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate font-medium">{a.links[link.key]}</span>
                      <span className="shrink-0 font-mono text-xs text-dx-muted">{link.host}</span>
                      <ArrowUpRight size={13} className="shrink-0 text-dx-muted" aria-hidden="true" />
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="min-w-0">
            <h2 className={H2}>{a.timelineTitle}</h2>
            <p className="mt-3 text-dx-muted">{a.timelineLead}</p>
            <ol className="relative ml-1.5 mt-6 border-l border-dx-line pl-6">
              {a.timeline.map((release) => (
                <li key={release.version} className="relative pb-5">
                  <span
                    className="absolute -left-[1.85rem] top-1 h-3 w-3 rounded-full border-2 border-dx-bg bg-sky-400"
                    aria-hidden="true"
                  />
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-sm font-semibold text-dx-fg">{release.version}</span>
                    <span className="text-xs text-dx-muted">{release.date}</span>
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-dx-muted">{release.text}</p>
                </li>
              ))}
              <li className="relative">
                <span
                  className="absolute -left-[1.98rem] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-dx-accent-soft"
                  aria-hidden="true"
                >
                  <span className="h-2 w-2 animate-pulse rounded-full bg-dx-accent" />
                </span>
                <p className="text-sm font-semibold text-dx-accent">{a.unreleasedLabel}</p>
                <p className="mt-1 text-sm leading-relaxed text-dx-muted">{a.unreleasedText}</p>
                <a
                  href={`${REPO}/blob/main/CHANGELOG.md`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-dx-accent hover:underline"
                >
                  CHANGELOG.md <ArrowRight size={16} aria-hidden="true" />
                </a>
              </li>
            </ol>
          </div>
        </section>

        {/* Team and partners: vertical cards like the SynapseOne and SynapseCity About pages. */}
        <section className="mt-20">
          <h2 className={H2}>{a.teamTitle}</h2>
          <p className="mt-2 text-dx-muted">{a.teamLead}</p>
          <ul className="mt-8 grid gap-5 sm:grid-cols-3">
            {TEAM.map((member) => (
              <li
                key={member.name}
                className={cn('flex flex-col items-center rounded-2xl border border-dx-line bg-dx-surface px-5 py-8 text-center', CARD_HOVER)}
              >
                <Avatar member={member} />
                <span className="mt-4 font-semibold">{member.name}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-20">
          <h2 className={H2}>{a.partnersTitle}</h2>
          <p className="mt-2 text-dx-muted">{a.partnersLead}</p>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PARTNERS.map((partner) => (
              <li key={partner.key}>
                <a
                  href={partner.href}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-4 rounded-xl border border-dx-line bg-dx-surface p-3 transition hover:border-dx-accent"
                >
                  {/* Logos are drawn for white, so the tile stays white in dark mode. */}
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[#fff] p-1.5">
                    <img src={partner.logo} alt="" className="max-h-full max-w-full object-contain" />
                  </span>
                  <span className="font-medium">{a.partners[partner.key]}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
