// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button, Card, EmptyState, inputClassName } from '../../../components/ui';
import { Modal, ModalError } from '../../../components/Modal';
import { toast } from '../../../stores/toastStore';
import {
  catalogProducts,
  catalogRoles,
  type WorkspaceCatalog,
  type WorkspaceMember,
  type WorkspaceProduct,
} from '../../../lib/workspaces';
import { fetchMembers, updateMemberRoles } from '../../../lib/workspacesApi';

const PRODUCT_LABELS: Partial<Record<WorkspaceProduct, string>> = {
  city: 'SynapseCity',
  sos: 'SynapseCity SOS',
  dx: 'Capability templates',
};

/**
 * Member products and their assignable roles come from the workspace catalog
 * the capability service advertises — never from a hardcoded list, so a new
 * product or role ships without editing this panel.
 */
export function MembersPanel({ catalog, onChanged }: { catalog: WorkspaceCatalog | null; onChanged: () => void }) {
  const members = useQuery({ queryKey: ['workspace-members'], queryFn: fetchMembers, retry: false });
  const [open, setOpen] = useState(false), [subject, setSubject] = useState(''), [grants, setGrants] = useState<WorkspaceMember['productRoles']>({}), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const products = catalogProducts(catalog).map((item) => item.product);
  const rolesFor = (product: WorkspaceProduct) => catalogRoles(catalog, product);
  const labelFor = (product: WorkspaceProduct) => PRODUCT_LABELS[product] ?? product;
  const edit = (member?: WorkspaceMember) => { setSubject(member?.subject || ''); setGrants(structuredClone(member?.productRoles || {})); setError(''); setOpen(true); };
  const save = async () => {
    setBusy(true); setError('');
    try {
      await updateMemberRoles(subject, grants);
      await members.refetch();
      onChanged();
      setOpen(false);
      toast('App membership updated.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="space-y-5"><Card className="p-6"><div className="flex flex-wrap justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-widest text-teal-600">App access</p><h2 className="mt-2 text-xl font-semibold">Members & roles</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-dx-muted">Assign each app independently. A City role never grants SOS access. Each app’s Common workspace uses that app’s members and its own data.</p></div><div className="flex items-start gap-2"><Button variant="ghost" onClick={() => void members.refetch()}><RefreshCw size={14} />Refresh</Button><Button variant="primary" onClick={() => edit()}><Plus size={14} />Add member</Button></div></div></Card>
    {members.isError ? <ModalError message={members.error.message} /> : !(members.data || []).length ? <EmptyState title="No app memberships" message="Assign a verified organization user to an app to get started." /> : <div className="overflow-x-auto rounded-xl border border-dx-line bg-dx-surface"><table className="w-full text-left text-xs"><thead className="bg-dx-subtle text-dx-muted"><tr><th className="p-4">Member</th>{products.map((product) => <th key={product} className="p-4">{labelFor(product)}</th>)}<th className="p-4">Access</th></tr></thead><tbody className="divide-y divide-dx-line">{members.data?.map(member => <tr key={member.subject}><td className="p-4 font-mono">{member.subject}</td>{products.map(product => <td key={product} className="p-4">{member.productRoles[product]?.length ? member.productRoles[product]!.join(' · ') : <span className="text-dx-muted">No membership</span>}</td>)}<td className="p-4"><button className="flex items-center gap-1.5 text-teal-600" onClick={() => edit(member)}><Pencil size={13} />Edit app roles</button></td></tr>)}</tbody></table></div>}
    <Modal open={open} onClose={() => { if (!busy) setOpen(false); }} title="App membership" eyebrow="Organization administration" footer={<><Button onClick={() => setOpen(false)} disabled={busy}>Cancel</Button><Button variant="primary" onClick={() => void save()} disabled={busy || !subject.trim()}>{busy ? 'Saving…' : 'Save app access'}</Button></>}><label className="block text-xs font-medium">Organization user ID<input className={inputClassName + ' mt-2'} value={subject} onChange={event => setSubject(event.target.value)} placeholder="Verified user ID"/></label><div className="mt-5 space-y-4">{products.map(product => { const roles = rolesFor(product); return <fieldset key={product} className="rounded-xl border border-dx-line p-4"><legend className="px-1 text-sm font-semibold">{labelFor(product)}</legend><p className="mb-3 text-xs text-dx-muted">Operations and this app’s Common workspace</p>{roles.length ? <div className="flex flex-wrap gap-3">{roles.map(role => <label key={role} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={grants[product]?.includes(role) || false} onChange={event => setGrants(current => ({ ...current, [product]: event.target.checked ? [...current[product] || [], role] : (current[product] || []).filter(value => value !== role) }))} />{role}</label>)}</div> : <p className="text-xs text-amber-700 dark:text-amber-300">The catalog did not advertise roles for this app; server-side validation stays authoritative.</p>}</fieldset>; })}</div><p className="mt-4 flex gap-2 text-xs leading-5 text-dx-muted"><ShieldCheck size={16} className="shrink-0" />App admin roles manage business operations. Only the verified organization administrator can open Studio and DX administration.</p><ModalError message={error} /></Modal>
  </div>;
}
