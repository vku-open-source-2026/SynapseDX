// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Organization membership roles for the member workspace. */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pencil, RefreshCw, Users } from 'lucide-react';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Pill,
  Skeleton,
  SmallButton,
  TableShell,
  Td,
  Th,
  Thead,
  Tr,
  inputClassName,
} from '../../../components/ui';
import { Modal, ModalError } from '../../../components/Modal';
import { toast } from '../../../stores/toastStore';
import {
  catalogMembershipRoles,
  isSafeRole,
  type WorkspaceCatalog,
  type WorkspaceMember,
} from '../../../lib/workspaces';
import { fetchMembers, updateMemberRoles } from '../../../lib/workspacesApi';

function errorText(error: unknown): string {
  const value = error as { message?: string; code?: string };
  const message = value?.message || 'The capability service refused the request.';
  return value?.code ? `${message} (${value.code})` : message;
}

export function MembersPanel({ catalog, onChanged }: { catalog: WorkspaceCatalog | null; onChanged: () => void }) {
  const members = useQuery({ queryKey: ['workspace-members'], queryFn: fetchMembers, retry: false });
  const [target, setTarget] = useState<WorkspaceMember | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roleOptions = useMemo(() => {
    const options = new Set(catalogMembershipRoles(catalog));
    for (const role of target?.roles ?? []) options.add(role);
    return Array.from(options);
  }, [catalog, target]);

  const open = (member: WorkspaceMember) => {
    setTarget(member);
    setRoles(member.roles);
    setManual(member.roles.join(', '));
    setError(null);
  };

  const save = async () => {
    if (!target || busy) return;
    const nextRoles = roleOptions.length > 0
      ? roles
      : manual
          .split(',')
          .map((role) => role.trim())
          .filter(Boolean);
    if (nextRoles.some((role) => !isSafeRole(role))) {
      setError('Roles must be plain role keys; public/anonymous roles are rejected.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateMemberRoles(target.subject, nextRoles);
      toast('Membership roles updated.');
      setTarget(null);
      await members.refetch();
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          eyebrow="Organization membership"
          title="Member roles"
          description="Roles are stored by the capability service and are the only authority for /workspace page visibility and form execution. The browser never grants a role."
          actions={
            <Button variant="ghost" onClick={() => void members.refetch()} disabled={members.isFetching}>
              <RefreshCw size={14} /> Refresh
            </Button>
          }
        />
        <div className="px-5 py-3 text-xs text-slate-500 dark:text-slate-400">
          <p>
            Assign roles to verified subjects in your organization. The capability service bootstraps the verified
            organization administrator's membership on the first admin request; this UI cannot grant itself access.
          </p>
        </div>
      </Card>

      {members.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : members.isError ? (
        <Card className="p-6">
          <ModalError message={errorText(members.error)} />
          <Button className="mt-3" variant="primary" onClick={() => void members.refetch()}>Retry</Button>
        </Card>
      ) : (members.data ?? []).length === 0 ? (
        <Card className="p-6">
          <EmptyState
            icon={<Users size={20} />}
            title="No members have workspace roles"
            message="Use the capability API or the deployment bootstrap to assign the first organization administrator."
          />
        </Card>
      ) : (
        <Card>
          <TableShell>
            <Thead>
              <Th>Subject</Th>
              <Th>Workspace roles</Th>
              <Th>Updated</Th>
              <Th><span className="sr-only">Actions</span></Th>
            </Thead>
            <tbody>
              {(members.data ?? []).map((member) => (
                <Tr key={member.subject}>
                  <Td className="font-mono text-xs">{member.subject}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {member.roles.length > 0 ? (
                        member.roles.map((role) => <Pill key={role} tone="neutral">{role}</Pill>)
                      ) : (
                        <span className="text-xs text-slate-400">No roles</span>
                      )}
                    </div>
                  </Td>
                  <Td className="text-xs text-slate-500">{member.updatedAt ? new Date(member.updatedAt).toLocaleString() : '—'}</Td>
                  <Td>
                    <SmallButton type="button" onClick={() => open(member)}>
                      <Pencil size={13} /> Edit roles
                    </SmallButton>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableShell>
        </Card>
      )}

      <Modal
        open={Boolean(target)}
        onClose={() => setTarget(null)}
        title={target ? `Roles for ${target.subject}` : 'Member roles'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTarget(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save roles'}
            </Button>
          </>
        }
      >
        {target ? (
          <div className="space-y-3">
            {roleOptions.length > 0 ? (
              <fieldset>
                <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">Roles</legend>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {roleOptions.map((role) => (
                    <label
                      key={role}
                      className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 dark:border-[#26354d] dark:text-slate-200"
                    >
                      <input
                        type="checkbox"
                        checked={roles.includes(role)}
                        onChange={(event) =>
                          setRoles(
                            event.target.checked
                              ? [...roles, role]
                              : roles.filter((item) => item !== role),
                          )
                        }
                      />
                      {role}
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : (
              <Field label="Roles" help="The catalog did not advertise roles; enter comma-separated role keys. The server validates them.">
                <input
                  className={inputClassName}
                  value={manual}
                  onChange={(event) => setManual(event.target.value)}
                />
              </Field>
            )}
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Removing all roles revokes workspace page visibility for this subject. Page data and execution still
              require the role checks performed by the capability service.
            </p>
            <ModalError message={error} />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
