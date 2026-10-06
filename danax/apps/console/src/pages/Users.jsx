import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Card, Empty, Err, PageTitle, Table } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

export default function Users() {
  const { headers } = useAuth();
  const scope = useScope();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!scope.orgId) {
      setRows([]);
      return;
    }
    api.users(scope.orgId, headers).then(setRows).catch(setErr);
  }, [scope.orgId]);

  return (
    <>
      <PageTitle title="Users" sub="Shadow user federated từ Authentik/Keycloak (email + OIDC sub)" />
      <Err e={err} />
      <ScopeBar scope={scope} showAccount={false} />
      <Card>
        {rows.length ? (
          <Table head={['Email', 'Tên', 'OIDC sub', 'Vai trò']}>
            {rows.map((u) => (
              <Row key={u.id} u={u} headers={headers} />
            ))}
          </Table>
        ) : (
          <Empty />
        )}
      </Card>
    </>
  );
}

function Row({ u, headers }) {
  const [n, setN] = useState(null);
  useEffect(() => {
    let live = true;
    api
      .userPolicies(u.id, headers)
      .then((p) => live && setN(Array.isArray(p) ? p.length : 0))
      .catch(() => live && setN(0));
    return () => {
      live = false;
    };
  }, [u.id]);
  return (
    <tr className="border-t border-slate-100">
      <td className="py-2 pr-4 font-medium text-main-text">{u.email}</td>
      <td className="py-2 pr-4">{u.display_name || '—'}</td>
      <td className="py-2 pr-4 text-xs text-normal-text font-mono">{u.external_sub?.slice(0, 18) || '—'}</td>
      <td className="py-2 pr-4">
        {n === null ? <span className="text-xs text-normal-text">…</span> : <Badge tone={n ? 'blue' : 'gray'}>{n} policies</Badge>}
      </td>
    </tr>
  );
}
