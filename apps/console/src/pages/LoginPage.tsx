// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState, useId } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ShieldCheck, Layers, ScrollText, Loader2, KeyRound } from 'lucide-react';
import { PublicHeader } from '../components/PublicHeader';
import { PublicFooter } from '../components/PublicFooter';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/toastStore';
import { Toaster } from '../components/Toaster';
import { Field, inputClassName } from '../components/ui';
import { PRIMARY_BTN } from '../components/public-styles';
import { useI18n, fill } from '../lib/i18n-context';
import { cn } from '../lib/utils';

const REDIRECT_TARGETS = new Set(['/admin', '/admin/datasets', '/admin/records', '/admin/modules', '/admin/settings']);
const POINT_ICONS = [Layers, ShieldCheck, ScrollText];

export function LoginPage() {
  const navigate = useNavigate();
  const { m } = useI18n();
  const t = m.login;
  const search = useSearch({ strict: false }) as { redirect?: string };
  const login = useAuthStore((state) => state.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();
  const passwordId = useId();
  const orgId = useId();

  const target = REDIRECT_TARGETS.has(search?.redirect ?? '') ? (search!.redirect as string) : '/admin';

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (!email.trim() || !password) {
      setError(t.errRequired);
      return;
    }
    setSubmitting(true);
    try {
      const context = await login(email.trim(), password, orgSlug.trim() || undefined);
      toast(fill(t.signedIn, { who: context.user?.email || context.user?.id || 'operator' }));
      await navigate({ to: target as never });
    } catch (failure) {
      setError((failure as Error)?.message || t.errRefused);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col bg-dx-bg text-dx-fg">
      <PublicHeader />
      <main className="mx-auto grid w-full max-w-6xl flex-1 gap-10 px-4 py-12 sm:px-6 lg:grid-cols-2 lg:items-center lg:py-20">
        <div className="hidden min-w-0 lg:block">
          <p className="text-sm font-medium text-dx-accent">{m.home.tierLine}</p>
          <h1 className="mt-3 max-w-lg text-4xl font-semibold leading-[1.15] tracking-tight text-balance">{m.home.title}</h1>
          <p className="mt-5 max-w-md leading-relaxed text-dx-muted text-pretty">{t.lead}</p>
          <ul className="mt-8 max-w-md divide-y divide-dx-line border-y border-dx-line">
            {t.points.map((point, index) => {
              const Icon = POINT_ICONS[index];
              return (
                <li key={point} className="flex items-center gap-3 py-3 text-sm text-dx-fg">
                  <Icon size={17} className="shrink-0 text-dx-accent" aria-hidden="true" /> {point}
                </li>
              );
            })}
          </ul>
          <p className="mt-6 max-w-md text-xs leading-relaxed text-dx-muted">{t.footnote}</p>
        </div>

        <div className="flex justify-center lg:justify-end">
          <form
            onSubmit={onSubmit}
            className="w-full max-w-md rounded-2xl border border-dx-line bg-dx-surface p-6 shadow-sm sm:p-8"
            noValidate
          >
            <div className="mb-6 flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-md shadow-sky-500/25">
                <KeyRound size={20} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold tracking-tight text-dx-fg">{t.formTitle}</h2>
                <p className="text-sm text-dx-muted">{t.formLead}</p>
              </div>
            </div>

            <div className="space-y-4">
              <Field label={t.email} required>
                <input
                  id={emailId}
                  name="email"
                  type="email"
                  autoComplete="username"
                  className={inputClassName}
                  placeholder="operator@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </Field>
              <Field label={t.password} required>
                <input
                  id={passwordId}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  className={inputClassName}
                  placeholder="••••••••"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </Field>
              <Field label={t.org} help={t.orgHelp}>
                <input
                  id={orgId}
                  name="orgSlug"
                  type="text"
                  autoComplete="organization"
                  className={inputClassName}
                  placeholder="acme"
                  value={orgSlug}
                  onChange={(event) => setOrgSlug(event.target.value)}
                />
              </Field>
            </div>

            {error ? (
              <p
                role="alert"
                className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
              >
                {error}
              </p>
            ) : null}

            <button type="submit" className={cn(PRIMARY_BTN, 'mt-6 w-full')} disabled={submitting}>
              {submitting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : null}
              {t.submit}
            </button>
            <p className="mt-5 text-center text-sm text-dx-muted">
              {t.noAccount}{' '}
              <Link to="/" className="font-semibold text-dx-accent hover:underline">
                {t.back}
              </Link>
            </p>
          </form>
        </div>
      </main>
      <PublicFooter />
      <Toaster />
    </div>
  );
}
