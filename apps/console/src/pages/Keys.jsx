import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Code, Empty, Err, Field, Input, Modal, PageTitle, Table } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

export default function Keys() {
  const { headers } = useAuth();
  const scope = useScope();
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('console');
  const [created, setCreated] = useState(null);

  const create = async (e) => {
    e.preventDefault();
    try {
      const k = await api.createKey(scope.accountId, name, headers);
      setCreated(k);
      setOpen(false);
    } catch (ex) {
      setErr(ex);
    }
  };

  useEffect(() => {
    setErr(null);
  }, [scope.accountId]);

  return (
    <>
      <PageTitle title="API Keys" sub="Key dài hạn synapsedx_* — chỉ hiện 1 lần khi tạo" right={<Btn onClick={() => setOpen(true)}>+ Tạo key</Btn>} />
      <Err e={err} />
      <ScopeBar scope={scope} />
      <Card>
        <p className="text-sm text-normal-text">
          Key thuộc account <b className="text-main-text">{scope.accounts.find((a) => a.id === scope.accountId)?.slug || '—'}</b>.
          Thu hồi key cũ bằng <code className="text-xs">DELETE /v1/keys/:id</code> (lấy id từ response lúc tạo).
        </p>
        {!scope.accountId && <Empty text="Chọn account trước" />}
      </Card>
      {created && (
        <Modal title="API key mới (lưu ngay!)" onClose={() => setCreated(null)}>
          <Code data={{ id: created.id, prefix: created.prefix, apiKey: created.apiKey }} />
        </Modal>
      )}
      {open && (
        <Modal title="Tạo API key" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Tên key">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Btn type="submit">Tạo</Btn>
          </form>
        </Modal>
      )}
      <p className="mt-3 text-xs text-normal-text">
        <Badge>Tip</Badge> Bật <code>GATEWAY_VERIFY_APIKEY=true</code> để gateway verify key tập trung.
      </p>
    </>
  );
}
