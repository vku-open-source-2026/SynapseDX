// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState, useId } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Boxes, ShieldCheck, Layers, ScrollText, Loader2 } from 'lucide-react';
import { PublicHeader } from '../components/PublicHeader';
import { PublicFooter } from '../components/PublicFooter';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/toastStore';
import { Toaster } from '../components/Toaster';
import { Button, Field, inputClassName } from '../components/ui';

const REDIRECT_TARGETS = new Set(['/admin', '/admin/datasets', '/admin/records', '/admin/modules', '/admin/settings']);

export function LoginPage() {
  const navigate = useNavigate();
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
      setError('Email and password are required.');
      return;
    }
    setSubmitting(true);
    try {
      const context = await login(email.trim(), password, orgSlug.trim() || undefined);
      toast(`Signed in as ${context.user?.email || context.user?.id || 'operator'}.`);
      await navigate({ to: target as never });
    } catch (failure) {
      setError((failure as Error)?.message || 'The identity service refused the session.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col bg-[#f4f8fd] text-slate-900">
      <PublicHeader />
      <div className="grid flex-1 lg:grid-cols-2">
        <div
          className="relative hidden overflow-hidden bg-slate-950 text-white lg:flex lg:flex-col lg:justify-between lg:p-12"
          aria-hidden="true"
        >
          <div
            className="pointer-events-none absolute -left-32 top-24 h-96 w-96 rounded-full bg-blue-600/30 blur-3xl"
          />
          <div className="pointer-events-none absolute bottom-0 right-0 h-80 w-80 rounded-full bg-cyan-500/20 blur-3xl" />
          <div className="relative">
            <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-cyan-300">
              TIER 2 · PUBLIC CAPABILITY SERVICES
            </p>
            <h1 className="mt-4 max-w-lg text-4xl font-bold leading-tight tracking-tight">
              One contract for every domain product.
            </h1>
            <p className="mt-4 max-w-md text-base leading-7 text-slate-300">
              Datasets, records, publication, review and audit are a single capability contract.
              Sign in with your Tier-1 IAM account to operate the open-data layer.
            </p>
            <ul className="mt-8 space-y-3 text-sm text-slate-300">
              <li className="flex items-center gap-3">
                <Layers size={16} className="text-cyan-300" /> Datasets, records and bulk publication
              </li>
              <li className="flex items-center gap-3">
                <ShieldCheck size={16} className="text-cyan-300" /> Peer review and human-in-the-loop approvals
              </li>
              <li className="flex items-center gap-3">
                <ScrollText size={16} className="text-cyan-300" /> Tenant-scoped audit and usage accounting
              </li>
            </ul>
          </div>
          <p className="relative text-xs text-slate-500">
            SynapseDX is the reusable capability tier of the SynapseOne platform. Passwords and sessions remain with
            the Tier-1 identity service — never stored by this console.
          </p>
        </div>

        <div className="flex items-center justify-center p-6">
          <form
            onSubmit={onSubmit}
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
            noValidate
          >
            <div className="mb-5 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white">
                <Boxes size={20} />
              </span>
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-slate-900">Sign in to SynapseDX</h2>
                <p className="text-sm text-slate-500">Use your Tier-1 IAM account.</p>
              </div>
            </div>

            <div className="space-y-4">
              <Field label="Email" required>
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
              <Field label="Password" required>
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
              <Field
                label="Organization slug"
                help="Optional when this deployment is bound to one organization."
              >
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
              <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            ) : null}

            <Button
              variant="primary"
              type="submit"
              className="mt-5 w-full justify-center py-2.5"
              disabled={submitting}
            >
              {submitting ? <Loader2 size={16} className="animate-spin" /> : null}
              Sign in
            </Button>
            <p className="mt-4 text-center text-xs text-slate-400">
              No account?{' '}
              <Link to="/" className="font-semibold text-blue-700 hover:text-blue-600">
                Back to the public catalog
              </Link>
            </p>
          </form>
        </div>
      </div>
      <PublicFooter />
      <Toaster />
    </div>
  );
}
