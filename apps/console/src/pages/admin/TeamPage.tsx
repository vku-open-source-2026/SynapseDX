// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Team and roles: tenant members, role assignment and policy visibility (Tier-1 owned). */
import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, ShieldCheck, Trash2, UserCog, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { can } from '../../lib/rbac';
import { useAuthStore } from '../../stores/authStore';
import { useToastStore } from '../../stores/toastStore';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  Field,
  TableShell,
  Thead,
  Th,
  Td,
  Tr,
  inputClassName,
  selectClassName,
} from '../../components/ui';
import { Modal, ModalError } from '../../components/Modal';
import type { TeamDto } from '../../types';

interface RoleAssignment {
  id?: string;
  roleId?: string;
  slug?: string;
  name?: string;
}

function assignmentRoleId(assignment: RoleAssignment | string): string {
  return typeof assignment === 'string' ? assignment : assignment.id || assignment.roleId || '';
}
function assignmentRoleLabel(assignment: RoleAssignment | string): string {
  if (typeof assignment === 'string') return assignment;
  return assignment.slug || assignment.name || assignment.id || assignment.roleId || 'role';
}

function NewRoleModal({
  open,
  accountId,
  onClose,
  onCreated,
}: {
  open: boolean;
  accountId?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const push = useToastStore((state) => state.push);
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSlug('');
      setDescription('');
      setError(null);
    }
  }, [open]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const value = slug.trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(value)) {
      setError('Slug must use lowercase letters, digits or hyphens.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/capabilities/management/team/roles', {
        slug: value,
        description: description.trim(),
        ...(accountId ? { accountId } : {}),
      });
      push('Role created. Assign it to a team member.');
      onCreated();
      onClose();
    } catch (failure) {
      setError((failure as Error)?.message || 'The role could not be created.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New role"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" form="role-form" type="submit" disabled={busy || !slug.trim()}>
            {busy ? 'Creating…' : 'Create role'}
          </Button>
        </>
      }
    >
      <form id="role-form" onSubmit={submit} className="grid gap-4">
        <Field label="Role slug" required help="Lowercase letters, digits or hyphens; used by the identity policy.">
          <input className={inputClassName} value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="moderator" required autoFocus />
        </Field>
        <Field label="Description">
          <textarea className={inputClassName} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <ModalError message={error} />
      </form>
    </Modal>
  );
}

export function TeamPage() {
  const context = useAuthStore((state) => state.context);
  const queryClient = useQueryClient();
  const push = useToastStore((state) => state.push);
  const [accountId, setAccountId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [newRoleOpen, setNewRoleOpen] = useState(false);
  const [assignSelections, setAssignSelections] = useState<Record<string, string>>({});

  const readable = can(context, 'users:read');

  const teamQuery = useQuery({
    queryKey: ['management/team', accountId || 'default'],
    enabled: readable,
    queryFn: () =>
      api.get<TeamDto>(
        accountId
          ? `/v1/capabilities/management/team?accountId=${encodeURIComponent(accountId)}`
          : '/v1/capabilities/management/team',
      ),
    retry: false,
  });
  const data = teamQuery.data;
  const members = data?.members ?? [];
  const roles = data?.roles ?? [];
  const policies = data?.policies ?? [];
  const accounts = data?.accounts ?? [];
  const activeAccount = data?.account || accountId;

  useEffect(() => {
    if (data?.account && !accountId) setAccountId(data.account);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.account]);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['management/team'] });

  const assignMutation = useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string }) =>
      api.post(`/v1/capabilities/management/team/${encodeURIComponent(userId)}/roles`, { roleId }),
    onSuccess: () => {
      invalidate();
      push('Role assigned.');
    },
    onError: (failure: Error) => push(failure?.message || 'The role could not be assigned.', 'bad'),
  });

  const removeMutation = useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string }) =>
      api.del(`/v1/capabilities/management/team/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`),
    onSuccess: () => {
      invalidate();
      push('Role removed.');
    },
    onError: (failure: Error) => push(failure?.message || 'The role could not be removed.', 'bad'),
  });

  const filteredMembers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members.filter((member) => {
      if (!q) return true;
      const haystack = `${member.displayName || ''} ${member.email || ''} ${member.id || ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [members, query]);
  const visibleMembers = filteredMembers.slice(0, query.trim() ? 50 : 20);

  if (!readable) {
    return (
      <Card className="p-6">
        <p className="text-sm font-semibold text-red-700">Team administration requires an administrator.</p>
      </Card>
    );
  }

  const roleSlug = (role: { id?: string; slug?: string; name?: string }) => role.slug || role.name || role.id || '';

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeader
          eyebrow="ACCESS CONTROL"
          title="Team and roles"
          description="Membership and role assignment are owned by Tier-1 IAM. This page only projects the verified tenant's users and roles; changes are audited."
          actions={
            <>
              {accounts.length > 0 ? (
                <select
                  className={`${selectClassName} w-44`}
                  aria-label="Account"
                  id="team-account"
                  value={activeAccount || ''}
                  onChange={(event) => setAccountId(event.target.value)}
                >
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.displayName || account.slug || account.id}
                    </option>
                  ))}
                </select>
              ) : null}
              <Button variant="primary" data-action="new-role" onClick={() => setNewRoleOpen(true)}>
                <UserCog size={16} /> New role
              </Button>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                {members.length} member{members.length === 1 ? '' : 's'}
              </span>
            </>
          }
        />
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3">
          <div className="relative min-w-[220px] flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              id="team-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search member, email or id…"
              aria-label="Search members"
              className={`${inputClassName} pl-9`}
            />
          </div>
          <span className="text-xs text-slate-500">Showing {visibleMembers.length} of {filteredMembers.length}</span>
        </div>

        {teamQuery.isLoading ? (
          <div className="grid gap-3 px-5 py-6">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-12 animate-pulse rounded-xl bg-slate-100" />
            ))}
          </div>
        ) : teamQuery.isError ? (
          <div className="px-5 py-8">
            <EmptyState
              title="The team could not be loaded"
              message={(teamQuery.error as Error)?.message}
              action={<Button variant="primary" onClick={() => void teamQuery.refetch()}>Retry</Button>}
            />
          </div>
        ) : members.length === 0 ? (
          <div className="px-5 py-8">
            <EmptyState icon={<Users size={26} />} title="No members are visible for this tenant" message="Grant membership in the Tier-1 IAM organization, or switch account." />
          </div>
        ) : (
          <TableShell>
            <Thead>
              <Th>Member</Th>
              <Th>Roles</Th>
              <Th>Assign</Th>
            </Thead>
            <tbody>
              {visibleMembers.map((member) => {
                const current = member.roles ?? [];
                const selectedRole = assignSelections[member.id] ?? roles[0]?.id ?? '';
                return (
                  <Tr key={member.id} data-team-row>
                    <Td>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-900">{member.displayName || member.email || member.id}</p>
                        <p className="truncate font-mono text-[11px] text-slate-400">{member.email || member.id}</p>
                      </div>
                    </Td>
                    <Td>
                      <div className="flex max-w-xs flex-wrap gap-1.5">
                        {current.length === 0 ? <span className="text-xs text-slate-400">No roles</span> : null}
                        {current.map((assignment, index) => {
                          const roleId = assignmentRoleId(assignment as RoleAssignment);
                          const label = assignmentRoleLabel(assignment as RoleAssignment);
                          return (
                            <span key={`${roleId}-${index}`} className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2.5 pr-1 text-[11px] font-medium text-slate-600">
                              {label}
                              <button
                                type="button"
                                aria-label={`Remove ${label}`}
                                className="rounded-full p-0.5 text-slate-400 hover:bg-red-100 hover:text-red-600"
                                onClick={() => removeMutation.mutate({ userId: member.id, roleId })}
                              >
                                <Trash2 size={11} />
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    </Td>
                    <Td>
                      {roles.length > 0 ? (
                        <div className="flex items-center gap-2">
                          <select
                            className={`${selectClassName} w-36`}
                            data-role-select={member.id}
                            aria-label={`Role for ${member.email || member.id}`}
                            value={selectedRole}
                            onChange={(event) => setAssignSelections((current) => ({ ...current, [member.id]: event.target.value }))}
                          >
                            {roles.map((role) => (
                              <option key={role.id} value={role.id}>{roleSlug(role)}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            data-action="assign-role"
                            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                            onClick={() => {
                              if (!selectedRole) {
                                push('Choose a role first.', 'warn');
                                return;
                              }
                              assignMutation.mutate({ userId: member.id, roleId: selectedRole });
                            }}
                          >
                            Assign
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">Create a role first</span>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </Card>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Roles</p>
          <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-slate-900">{roles.length} role{roles.length === 1 ? '' : 's'}</h2>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {roles.length ? roles.map((role) => <Chip key={role.id}>{roleSlug(role)}</Chip>) : <p className="text-sm text-slate-500">No roles</p>}
          </div>
        </Card>
        <Card className="p-5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Policies</p>
          <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-slate-900">{policies.length} {policies.length === 1 ? 'policy' : 'policies'}</h2>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {policies.length ? policies.map((policy) => <Chip key={policy.id}>{policy.name || policy.id}</Chip>) : <p className="text-sm text-slate-500">No policies</p>}
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-400">
            <ShieldCheck size={14} className="text-emerald-500" /> Policy evaluation happens in Tier-1 IAM on every request.
          </div>
        </Card>
      </section>

      <NewRoleModal open={newRoleOpen} accountId={accountId || undefined} onClose={() => setNewRoleOpen(false)} onCreated={invalidate} />
    </div>
  );
}
