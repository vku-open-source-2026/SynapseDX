/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBolt,
  faRotateRight,
  faPlus,
  faTrash,
  faClock,
  faKey,
  faLock,
  faMagnifyingGlass,
  faPen,
  faLayerGroup,
  faServer,
  faGaugeHigh,
} from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import {
  Badge,
  Btn,
  Card,
  Code,
  Empty,
  Err,
  Field,
  Input,
  Modal,
  PageTitle,
  Table,
  TableSkeleton,
  ListSkeleton,
} from '../components/ui.jsx';

export default function SynapseFaststore() {
  const { headers } = useAuth();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // Key scanner
  const [keys, setKeys] = useState([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [prefix, setPrefix] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);

  // Selected key detail
  const [selectedKey, setSelectedKey] = useState(null);
  const [keyDetail, setKeyDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Modals & action states
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newType, setNewType] = useState('string');
  const [newValue, setNewValue] = useState('{\n  "greeting": "hello synapse"\n}');
  const [newTtl, setNewTtl] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [ttlModalOpen, setTtlModalOpen] = useState(false);
  const [ttlSecs, setTtlSecs] = useState(300);
  const [ttlSubmitting, setTtlSubmitting] = useState(false);

  // Sub-tab for view: 'keys' | 'locks'
  const [viewTab, setViewTab] = useState('keys');

  // Distributed Lock state
  const [lockName, setLockName] = useState('sync-batch');
  const [lockTtl, setLockTtl] = useState(60);
  const [lockWait, setLockWait] = useState(2000);
  const [lockResult, setLockResult] = useState(null);
  const [lockToken, setLockToken] = useState('');
  const [lockBusy, setLockBusy] = useState(false);

  const loadSeq = useRef(0);

  const loadStats = async () => {
    try {
      const s = await api.faststoreStats(headers);
      setStats(s);
    } catch {
      /* ignore */
    }
  };

  const loadKeys = async (c = null) => {
    const seq = ++loadSeq.current;
    setKeysLoading(true);
    setErr(null);
    try {
      const res = await api.faststoreKeys(
        {
          prefix: prefix.trim() || undefined,
          cursor: c || undefined,
          limit: 50,
        },
        headers,
      );
      if (seq === loadSeq.current) {
        const list = res?.keys || [];
        setKeys(list);
        setCursor(res?.cursor || null);
        setHasMore(!!res?.truncated);
        if (list.length > 0 && !selectedKey) {
          inspectKey(list[0].key || list[0]);
        }
      }
    } catch (e) {
      if (seq === loadSeq.current) setErr(e);
    } finally {
      if (seq === loadSeq.current) setKeysLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
    loadKeys();
  }, [headers]);

  const inspectKey = async (keyName) => {
    setSelectedKey(keyName);
    setDetailLoading(true);
    try {
      const [val, ttlRes] = await Promise.all([
        api.faststoreGet(keyName, headers),
        api.faststoreTtl(keyName, headers).catch(() => ({ ttlSeconds: -1 })),
      ]);
      setKeyDetail({
        ...val,
        ttlSeconds: ttlRes?.ttlSeconds ?? val?.ttlSeconds ?? -1,
      });
    } catch (e) {
      setKeyDetail({ key: keyName, error: e.message || String(e) });
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCreateKey = async (e) => {
    e.preventDefault();
    if (!newKey.trim() || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      let parsedValue;
      try {
        parsedValue = JSON.parse(newValue);
      } catch {
        parsedValue = newValue;
      }

      const ttl = newTtl ? Number(newTtl) : undefined;

      if (newType === 'string') {
        await api.faststoreSet(newKey.trim(), { value: parsedValue, ttlSeconds: ttl }, headers);
      } else if (newType === 'hash') {
        await api.faststoreHashSet(newKey.trim(), typeof parsedValue === 'object' ? parsedValue : { val: parsedValue }, headers);
      } else if (newType === 'list') {
        const arr = Array.isArray(parsedValue) ? parsedValue : [parsedValue];
        await api.faststoreListPush(newKey.trim(), { values: arr, side: 'right' }, headers);
      } else if (newType === 'set') {
        const members = Array.isArray(parsedValue) ? parsedValue : [String(parsedValue)];
        await api.faststoreSetAdd(newKey.trim(), { members }, headers);
      } else if (newType === 'zset') {
        const members = Array.isArray(parsedValue) ? parsedValue : [{ member: String(parsedValue), score: 1 }];
        await api.faststoreZsetAdd(newKey.trim(), { members }, headers);
      }

      setCreateModalOpen(false);
      const k = newKey.trim();
      setNewKey('');
      await loadStats();
      await loadKeys();
      inspectKey(k);
    } catch (e) {
      setErr(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteKey = async (keyName) => {
    if (!window.confirm(`Delete key "${keyName}"?`)) return;
    try {
      await api.faststoreDelete(keyName, headers);
      if (selectedKey === keyName) {
        setSelectedKey(null);
        setKeyDetail(null);
      }
      await loadStats();
      await loadKeys();
    } catch (e) {
      setErr(e);
    }
  };

  const handleIncr = async (keyName, by = 1) => {
    try {
      const res = await api.faststoreIncr(keyName, { by }, headers);
      await inspectKey(keyName);
    } catch (e) {
      setErr(e);
    }
  };

  const handleExpire = async (e) => {
    e.preventDefault();
    if (!selectedKey || ttlSubmitting) return;
    setTtlSubmitting(true);
    try {
      await api.faststoreExpire(selectedKey, Number(ttlSecs), headers);
      setTtlModalOpen(false);
      await inspectKey(selectedKey);
    } catch (e) {
      setErr(e);
    } finally {
      setTtlSubmitting(false);
    }
  };

  const handleAcquireLock = async (e) => {
    e.preventDefault();
    if (!lockName.trim() || lockBusy) return;
    setLockBusy(true);
    setLockResult(null);
    try {
      const res = await api.faststoreLockAcquire(
        lockName.trim(),
        { ttlSeconds: Number(lockTtl) || 60, waitMs: Number(lockWait) || 2000 },
        headers,
      );
      setLockResult(res);
      if (res?.token) setLockToken(res.token);
    } catch (e) {
      setLockResult({ ok: false, error: e.message || String(e) });
    } finally {
      setLockBusy(false);
    }
  };

  const handleReleaseLock = async () => {
    if (!lockName.trim() || !lockToken.trim() || lockBusy) return;
    setLockBusy(true);
    try {
      const res = await api.faststoreLockRelease(lockName.trim(), { token: lockToken.trim() }, headers);
      setLockResult({ ...res, message: 'Lock released successfully.' });
      setLockToken('');
    } catch (e) {
      setLockResult({ ok: false, error: e.message || String(e) });
    } finally {
      setLockBusy(false);
    }
  };

  const filteredKeys = keys.filter((k) => {
    const name = typeof k === 'string' ? k : k.key;
    const type = typeof k === 'object' ? k.type : 'string';
    if (typeFilter !== 'all' && type !== typeFilter) return false;
    return true;
  });

  return (
    <div>
      <PageTitle
        title="Synapse Faststore"
        sub="High-performance Redis-backed cache, key-value store, atomic counters, and distributed locks."
        right={
          <div className="flex gap-2">
            <Btn kind="secondary" onClick={() => { loadStats(); loadKeys(); }} loading={keysLoading}>
              <FontAwesomeIcon icon={faRotateRight} className="mr-1.5" /> Refresh
            </Btn>
            <Btn kind="primary" onClick={() => setCreateModalOpen(true)}>
              <FontAwesomeIcon icon={faPlus} className="mr-1.5" /> Set Key
            </Btn>
          </div>
        }
      />

      {err && <Err err={err} className="mb-6" />}

      {/* Top summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <Card className="p-4 text-center">
          <span className="text-xs text-normal-text block">Total Keys</span>
          <span className="text-2xl font-bold text-main-blue mt-1 block">
            {stats?.keys ?? keys.length}
          </span>
        </Card>
        <Card className="p-4 text-center">
          <span className="text-xs text-normal-text block">Backend Storage</span>
          <span className="text-sm font-semibold text-main-text mt-2 block capitalize">
            {stats?.backend || 'Redis / Memory'}
          </span>
        </Card>
        <Card className="p-4 text-center">
          <span className="text-xs text-normal-text block">Data Structures</span>
          <div className="flex justify-center gap-1.5 mt-2 flex-wrap">
            <Badge tone="blue">Strings</Badge>
            <Badge tone="green">Hashes</Badge>
            <Badge tone="amber">Lists/Sets</Badge>
          </div>
        </Card>
        <Card className="p-4 text-center">
          <span className="text-xs text-normal-text block">Distributed Locks</span>
          <span className="text-sm font-semibold text-emerald-600 mt-2 block">
            Redlock Active
          </span>
        </Card>
      </div>

      {/* Main Tabs */}
      <div className="flex gap-4 mb-4 text-sm font-medium border-b border-slate-200">
        <button
          onClick={() => setViewTab('keys')}
          className={`pb-2 border-b-2 flex items-center gap-2 ${
            viewTab === 'keys'
              ? 'border-main-blue text-main-blue'
              : 'border-transparent text-normal-text hover:text-main-text'
          }`}
        >
          <FontAwesomeIcon icon={faKey} /> Key/Value Explorer
        </button>
        <button
          onClick={() => setViewTab('locks')}
          className={`pb-2 border-b-2 flex items-center gap-2 ${
            viewTab === 'locks'
              ? 'border-main-blue text-main-blue'
              : 'border-transparent text-normal-text hover:text-main-text'
          }`}
        >
          <FontAwesomeIcon icon={faLock} /> Distributed Locks
        </button>
      </div>

      {viewTab === 'keys' ? (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Left: Key list */}
          <Card className="lg:col-span-1 p-4 flex flex-col h-[70vh]">
            <div className="space-y-2 mb-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-xs text-main-text">Scanned Keys</h3>
                <Badge tone="gray">{filteredKeys.length}</Badge>
              </div>

              <div className="relative">
                <FontAwesomeIcon
                  icon={faMagnifyingGlass}
                  className="absolute left-3 top-2.5 text-xs text-normal-text"
                />
                <input
                  type="text"
                  placeholder="Prefix (e.g. user:)"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && loadKeys()}
                  className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 text-xs outline-none focus:border-main-blue"
                />
              </div>

              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="w-full px-2 py-1.5 rounded-xl border border-slate-200 text-xs outline-none bg-white text-main-text"
              >
                <option value="all">All Types</option>
                <option value="string">String / JSON</option>
                <option value="hash">Hash</option>
                <option value="list">List</option>
                <option value="set">Set</option>
                <option value="zset">Sorted Set</option>
              </select>
            </div>

            <div className="flex-1 overflow-y-auto space-y-1 pr-1">
              {keysLoading && keys.length === 0 ? (
                <ListSkeleton rows={5} />
              ) : filteredKeys.length === 0 ? (
                <p className="text-xs text-normal-text text-center py-6">No keys found.</p>
              ) : (
                filteredKeys.map((k) => {
                  const keyName = typeof k === 'string' ? k : k.key;
                  const keyType = typeof k === 'object' ? k.type : 'string';
                  const isSelected = keyName === selectedKey;
                  return (
                    <div
                      key={keyName}
                      onClick={() => inspectKey(keyName)}
                      className={`p-2.5 rounded-2xl cursor-pointer transition-all border text-left flex items-center justify-between group ${
                        isSelected
                          ? 'border-main-blue bg-main-blue/10 text-main-blue font-medium'
                          : 'border-slate-100 hover:border-slate-200 hover:bg-slate-50 text-main-text'
                      }`}
                    >
                      <div className="min-w-0 pr-2">
                        <div className="font-mono text-xs truncate font-medium">{keyName}</div>
                        <span className="text-[10px] text-normal-text capitalize">{keyType}</span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteKey(keyName);
                        }}
                        title="Delete key"
                        className="opacity-0 group-hover:opacity-100 p-1 text-normal-text hover:text-red-500"
                      >
                        <FontAwesomeIcon icon={faTrash} className="text-xs" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </Card>

          {/* Right: Key Details */}
          <div className="lg:col-span-3">
            {!selectedKey ? (
              <Card className="p-12 text-center">
                <Empty
                  icon={<FontAwesomeIcon icon={faKey} className="text-3xl text-main-blue mb-2" />}
                  title="Select or create a key"
                  sub="Explore stored values, configure TTL expiration, or execute atomic operations."
                />
              </Card>
            ) : detailLoading ? (
              <Card className="p-6">
                <TableSkeleton rows={4} />
              </Card>
            ) : (
              <Card className="p-6 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-mono text-base font-semibold text-main-text">{selectedKey}</h3>
                      <Badge tone="blue">{keyDetail?.type || 'string'}</Badge>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-normal-text">
                      <span>
                        TTL:{' '}
                        {keyDetail?.ttlSeconds === undefined || keyDetail?.ttlSeconds === -1
                          ? 'No expiration (Persistent)'
                          : `${keyDetail.ttlSeconds}s remaining`}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {keyDetail?.type === 'string' && (
                      <button
                        onClick={() => handleIncr(selectedKey, 1)}
                        title="Atomically increment numeric counter"
                        className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-medium text-main-text"
                      >
                        Incr (+1)
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setTtlSecs(keyDetail?.ttlSeconds > 0 ? keyDetail.ttlSeconds : 300);
                        setTtlModalOpen(true);
                      }}
                      className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-medium text-main-text flex items-center gap-1"
                    >
                      <FontAwesomeIcon icon={faClock} /> Set TTL
                    </button>
                    <button
                      onClick={() => handleDeleteKey(selectedKey)}
                      className="px-3 py-1.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-xs font-medium text-red-500 flex items-center gap-1"
                    >
                      <FontAwesomeIcon icon={faTrash} /> Delete
                    </button>
                  </div>
                </div>

                <div>
                  <h4 className="text-xs font-semibold text-main-text mb-2">Key Value</h4>
                  <pre className="font-mono text-xs bg-slate-50 p-4 rounded-2xl overflow-x-auto max-h-96 text-main-text">
                    {JSON.stringify(keyDetail?.value ?? keyDetail, null, 2)}
                  </pre>
                </div>
              </Card>
            )}
          </div>
        </div>
      ) : (
        /* Distributed Locks Tab */
        <Card className="p-6 max-w-2xl space-y-4">
          <div>
            <h4 className="font-semibold text-main-text">Distributed Locks (Redlock)</h4>
            <p className="text-xs text-normal-text mt-0.5">
              Acquire mutually exclusive, tenant-scoped distributed locks across microservices and workers.
            </p>
          </div>

          <form onSubmit={handleAcquireLock} className="space-y-4">
            <Field label="Lock Name *">
              <Input
                required
                placeholder="e.g. sync-batch, payment-process"
                value={lockName}
                onChange={(e) => setLockName(e.target.value)}
              />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="TTL (Seconds, lease duration)">
                <Input
                  type="number"
                  min="1"
                  max="3600"
                  value={lockTtl}
                  onChange={(e) => setLockTtl(e.target.value)}
                />
              </Field>

              <Field label="Wait Timeout (Milliseconds)">
                <Input
                  type="number"
                  min="0"
                  max="60000"
                  value={lockWait}
                  onChange={(e) => setLockWait(e.target.value)}
                />
              </Field>
            </div>

            <div className="flex gap-2">
              <Btn kind="primary" type="submit" loading={lockBusy}>
                <FontAwesomeIcon icon={faLock} className="mr-1.5" /> Acquire Lock
              </Btn>
              {lockToken && (
                <Btn kind="secondary" onClick={handleReleaseLock} loading={lockBusy}>
                  Release Lock
                </Btn>
              )}
            </div>
          </form>

          {lockResult && (
            <div className="mt-4 p-4 rounded-2xl bg-slate-50 border border-slate-100 text-xs font-mono space-y-2">
              <div className="flex items-center gap-2">
                <span className="font-sans font-semibold">Status:</span>
                <Badge tone={lockResult.acquired || lockResult.ok ? 'green' : 'red'}>
                  {lockResult.acquired ? 'Acquired' : lockResult.error || 'Not Acquired'}
                </Badge>
              </div>
              {lockToken && (
                <div>
                  <span className="font-sans font-semibold">Token: </span>
                  <span className="text-main-blue">{lockToken}</span>
                </div>
              )}
              <pre className="text-[11px] overflow-x-auto text-normal-text">
                {JSON.stringify(lockResult, null, 2)}
              </pre>
            </div>
          )}
        </Card>
      )}

      {/* Modal: Set Key */}
      {createModalOpen && (
        <Modal title="Set Faststore Key" onClose={() => setCreateModalOpen(false)}>
          <form onSubmit={handleCreateKey} className="space-y-4">
            <Field label="Key Name *">
              <Input
                required
                placeholder="e.g. cache:user:123 or settings:app"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
              />
            </Field>

            <Field label="Data Type">
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm outline-none focus:border-main-blue bg-white"
              >
                <option value="string">String / JSON</option>
                <option value="hash">Hash (Object)</option>
                <option value="list">List (Array)</option>
                <option value="set">Set (Unique)</option>
                <option value="zset">Sorted Set (Scored)</option>
              </select>
            </Field>

            <Field label="Value (JSON or Primitive) *">
              <textarea
                rows={6}
                required
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                className="w-full font-mono text-xs px-3 py-2 rounded-2xl border border-slate-200 outline-none focus:border-main-blue"
              />
            </Field>

            <Field label="TTL (Seconds, optional)">
              <Input
                type="number"
                min="1"
                placeholder="e.g. 300 for 5 minutes (empty = persistent)"
                value={newTtl}
                onChange={(e) => setNewTtl(e.target.value)}
              />
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <Btn kind="secondary" onClick={() => setCreateModalOpen(false)}>
                Cancel
              </Btn>
              <Btn kind="primary" type="submit" loading={submitting}>
                Save Key
              </Btn>
            </div>
          </form>
        </Modal>
      )}

      {/* Modal: Set TTL */}
      {ttlModalOpen && (
        <Modal title={`Set Expiration TTL: ${selectedKey}`} onClose={() => setTtlModalOpen(false)}>
          <form onSubmit={handleExpire} className="space-y-4">
            <Field label="TTL (Seconds, 0 removes expiration)">
              <Input
                type="number"
                min="0"
                required
                value={ttlSecs}
                onChange={(e) => setTtlSecs(e.target.value)}
              />
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <Btn kind="secondary" onClick={() => setTtlModalOpen(false)}>
                Cancel
              </Btn>
              <Btn kind="primary" type="submit" loading={ttlSubmitting}>
                Apply TTL
              </Btn>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
