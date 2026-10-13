/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
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
      <PageTitle title="API Keys" sub="Long-lived synapsedx_* keys — shown only once at creation" right={<Btn onClick={() => setOpen(true)}>+ New key</Btn>} />
      <Err e={err} />
      <ScopeBar scope={scope} />
      <Card>
        <p className="text-sm text-normal-text">
          Keys belong to account <b className="text-main-text">{scope.accounts.find((a) => a.id === scope.accountId)?.slug || '—'}</b>.
          Revoke old keys with <code className="text-xs">DELETE /v1/keys/:id</code> (take the id from the creation response).
        </p>
        {!scope.accountId && <Empty text="Pick an account first" />}
      </Card>
      {created && (
        <Modal title="New API key (save it now!)" onClose={() => setCreated(null)}>
          <Code data={{ id: created.id, prefix: created.prefix, apiKey: created.apiKey }} />
        </Modal>
      )}
      {open && (
        <Modal title="New API key" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Key name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Btn type="submit">Create</Btn>
          </form>
        </Modal>
      )}
      <p className="mt-3 text-xs text-normal-text">
        <Badge>Tip</Badge> Enable <code>GATEWAY_VERIFY_APIKEY=true</code> for centralized gateway key verification.
      </p>
    </>
  );
}
