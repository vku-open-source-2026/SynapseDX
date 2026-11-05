// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Session, publication policy and role model. */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, ShieldCheck, Copy, Check } from 'lucide-react';
import { api, getHealth } from '../../lib/api';
import { can } from '../../lib/rbac';
import { useAuthStore } from '../../stores/authStore';
import { useToastStore } from '../../stores/toastStore';
import { Button, Card, CardHeader, Chip } from '../../components/ui';
import { ConfirmDialog } from '../../components/ui';
import { ModalError } from '../../components/Modal';

const ROLE_MODEL = [
  { role: 'Administrator', text: 'Full control, tenant settings and role visibility.' },
  { role: 'Operator', text: 'Datasets, records, publication and outbox recovery.' },
  { role: 'Moderator', text: 'Peer review, approval/rejection and audit review.' },
  { role: 'Manager', text: 'Read-only dashboards, audit and usage reporting.' },
];

export function SettingsPage() {
  const context = useAuthStore((state) => state.context);
  const queryClient = useQueryClient();
  const push = useToastStore((state) => state.push);
  const logout = useAuthStore((state) => state.logout);
  const logoutAll = useAuthStore((state) => state.logoutAll);

  const [requireReview, setRequireReview] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logoutAllOpen, setLogoutAllOpen] = useState(false);
  const [logoutAllBusy, setLogoutAllBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const canReadSettings = can(context, 'settings:read') || can(context, 'settings:write');
  const canWrite = can(context, 'settings:write');

  const settingsQuery = useQuery({
    queryKey: ['management/settings'],
    enabled: canReadSettings,
    queryFn: () => api.get<{ settings: { requireReview: boolean } }>('/v1/capabilities/management/settings'),
    retry: false,
  });
  const healthQuery = useQuery({ queryKey: ['health'], queryFn: getHealth, retry: false, staleTime: 30_000 });

  useEffect(() => {
    if (settingsQuery.data?.settings && !loaded) {
      setRequireReview(Boolean(settingsQuery.data.settings.requireReview));
      setLoaded(true);
    }
  }, [settingsQuery.data, loaded]);

  const savePolicy = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.patch<{ settings?: { requireReview: boolean } }>('/v1/capabilities/management/settings', { requireReview });
      void queryClient.setQueryData(['management/settings'], { settings: result?.settings ?? { requireReview } });
      push('Publication policy saved.');
    } catch (failure) {
      setError((failure as Error)?.message || 'The policy could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const confirmLogoutAll = async () => {
    setLogoutAllBusy(true);
    try {
      await logoutAll();
      push('All sessions revoked.');
    } catch (failure) {
      push((failure as Error)?.message || 'The sessions could not be revoked.', 'bad');
    } finally {
      setLogoutAllBusy(false);
      setLogoutAllOpen(false);
    }
  };

  const copyTenant = async () => {
    const tenant = context?.tenant || '';
    if (!tenant) return;
    try {
      await navigator.clipboard.writeText(tenant);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is best-effort; no user-facing failure.
    }
  };

  const scopes = context?.auth?.scopes ?? [];
  const email = context?.user?.email || context?.user?.id || '—';

  return (
    <div className="space-y-6">
      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader eyebrow="VERIFIED PRINCIPAL" title={email} />
          <div className="space-y-3 px-5 py-4 text-sm text-slate-600">
            <p>Roles: {(context?.roles ?? []).join(', ') || 'none'}</p>
            <dl className="grid grid-cols-[110px_1fr] gap-y-2">
              <dt className="text-slate-400">Tenant</dt>
              <dd className="flex items-center gap-2 font-mono text-xs">
                {context?.tenant || '—'}
                {context?.tenant ? (
                  <button type="button" onClick={() => void copyTenant()} aria-label="Copy tenant id" className="rounded p-0.5 text-slate-400 hover:text-slate-700">
                    {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
                  </button>
                ) : null}
              </dd>
              <dt className="text-slate-400">Account</dt>
              <dd className="font-mono text-xs">{context?.account || '—'}</dd>
              <dt className="text-slate-400">Organization</dt>
              <dd className="font-mono text-xs">{context?.org || '—'}</dd>
              <dt className="text-slate-400">Credential</dt>
              <dd className="font-mono text-xs">{context?.auth?.kind || '—'}</dd>
            </dl>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Scopes</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {scopes.length ? scopes.map((scope) => <Chip key={scope}>{scope}</Chip>) : <span className="text-xs text-slate-500">Scope-less Tier-1 key</span>}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader eyebrow="DEPENDENCIES" title={healthQuery.data?.status === 'ok' ? 'Tier chain healthy' : 'Tier chain degraded'} description="The console reads the public boundary only. Tier-1 details stay behind the capabilities API." />
          <div className="space-y-3 px-5 py-4 text-sm text-slate-600">
            <dl className="grid grid-cols-[110px_1fr] gap-y-2">
              <dt className="text-slate-400">Gateway</dt>
              <dd>{healthQuery.data?.status === 'ok'
                ? <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">OK</span>
                : <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-inset ring-red-200">Check</span>}</dd>
              <dt className="text-slate-400">API base</dt>
              <dd className="font-mono text-xs">{window.location.origin}</dd>
              <dt className="text-slate-400">Docs</dt>
              <dd><a className="text-blue-700 hover:underline" href="https://github.com/vku-open-source-2026/SynapseDX/blob/main/docs/API.md" target="_blank" rel="noreferrer">API reference ↗</a></dd>
            </dl>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="ghost" onClick={() => setLogoutAllOpen(true)}><LogOut size={15} /> Sign out all sessions</Button>
              <Button variant="ghost" onClick={() => void logout()}><LogOut size={15} /> Sign out</Button>
            </div>
          </div>
        </Card>
      </section>

      <Card>
        <CardHeader
          eyebrow="PUBLICATION POLICY"
          title={requireReview ? 'Review required' : 'Direct publication'}
          description="When review is required, a public dataset must be approved by a moderator before an operator can publish it."
        />
        <div className="space-y-3 px-5 py-4">
          {!canReadSettings ? (
            <p className="text-sm text-slate-500">The policy is unavailable for this role.</p>
          ) : (
            <>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <input
                  id="require-review"
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-blue-600"
                  checked={requireReview}
                  disabled={!canWrite || saving}
                  onChange={(event) => setRequireReview(event.target.checked)}
                />
                <span className="text-sm text-slate-700">
                  <span className="font-semibold">Require moderator approval before publication</span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {canWrite ? 'Changes apply to every publication on this tenant.' : 'Your role can view but not change this policy.'}
                  </span>
                </span>
              </label>
              {canWrite ? (
                <div>
                  <Button variant="primary" data-action="save-settings" onClick={() => void savePolicy()} disabled={saving}>
                    {saving ? 'Saving…' : 'Save policy'}
                  </Button>
                </div>
              ) : null}
              <ModalError message={error} />
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader eyebrow="ROLE MODEL" title="Management roles" />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
          {ROLE_MODEL.map((item) => (
            <div key={item.role} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <ShieldCheck size={14} className="text-blue-600" /> {item.role}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-500">{item.text}</p>
            </div>
          ))}
        </div>
      </Card>

      <ConfirmDialog
        open={logoutAllOpen}
        title="Sign out all sessions?"
        message="This revokes every refresh token for the account."
        label="Sign out all"
        danger
        busy={logoutAllBusy}
        onCancel={() => setLogoutAllOpen(false)}
        onConfirm={() => void confirmLogoutAll()}
      />
    </div>
  );
}
