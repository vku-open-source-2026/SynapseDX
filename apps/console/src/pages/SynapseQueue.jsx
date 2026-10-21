/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faInbox,
  faRotateRight,
  faPlus,
  faTrash,
  faPaperPlane,
  faPlay,
  faCheck,
  faXmark,
  faClock,
  faSkull,
  faArrowsRotate,
  faMagnifyingGlass,
  faLayerGroup,
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

const SAMPLE_PAYLOAD = JSON.stringify(
  {
    to: 'dev@acme.test',
    subject: 'Welcome to SynapseDX',
    template: 'onboarding-welcome',
    data: { role: 'engineer' },
  },
  null,
  2,
);

export default function SynapseQueue() {
  const { headers } = useAuth();
  const [queues, setQueues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [selectedQueue, setSelectedQueue] = useState(null);
  const [queueSearch, setQueueSearch] = useState('');
  const [activeTab, setActiveTab] = useState('peek'); // 'peek' | 'consume' | 'dead'

  // Stats for the selected queue
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Peek messages
  const [peekMessages, setPeekMessages] = useState([]);
  const [peekLoading, setPeekLoading] = useState(false);

  // Leased consumer simulation
  const [leased, setLeased] = useState([]);
  const [consumeLoading, setConsumeLoading] = useState(false);
  const [consumeMax, setConsumeMax] = useState(5);
  const [consumeTimeout, setConsumeTimeout] = useState(30);

  // Dead letters
  const [deadLetters, setDeadLetters] = useState([]);
  const [deadLoading, setDeadLoading] = useState(false);

  // Modals
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newQueueName, setNewQueueName] = useState('');
  const [newMaxAttempts, setNewMaxAttempts] = useState(5);
  const [newVisTimeout, setNewVisTimeout] = useState(30);
  const [createSubmitting, setCreateSubmitting] = useState(false);

  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [pubPayload, setPubPayload] = useState(SAMPLE_PAYLOAD);
  const [pubDelay, setPubDelay] = useState(0);
  const [pubDedupe, setPubDedupe] = useState('');
  const [pubSubmitting, setPubSubmitting] = useState(false);

  const loadSeq = useRef(0);

  const loadQueues = async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await api.queueList(headers);
      if (seq === loadSeq.current) {
        const list = Array.isArray(res) ? res : [];
        setQueues(list);
        if (list.length > 0 && !selectedQueue) {
          setSelectedQueue(list[0].queue || list[0].name);
        } else if (list.length === 0) {
          setSelectedQueue(null);
        }
      }
    } catch (e) {
      if (seq === loadSeq.current) setErr(e);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    loadQueues();
  }, [headers]);

  const loadQueueDetails = async () => {
    if (!selectedQueue) return;
    setStatsLoading(true);
    try {
      const s = await api.queueStats(selectedQueue, headers);
      setStats(s);
    } catch (e) {
      setErr(e);
    } finally {
      setStatsLoading(false);
    }
  };

  const loadPeek = async () => {
    if (!selectedQueue) return;
    setPeekLoading(true);
    try {
      const res = await api.queuePeek(selectedQueue, { limit: 50 }, headers);
      setPeekMessages(res?.messages || []);
    } catch (e) {
      setErr(e);
    } finally {
      setPeekLoading(false);
    }
  };

  const loadDeadLetters = async () => {
    if (!selectedQueue) return;
    setDeadLoading(true);
    try {
      const res = await api.queueDead(selectedQueue, { limit: 50 }, headers);
      setDeadLetters(res?.messages || []);
    } catch (e) {
      setErr(e);
    } finally {
      setDeadLoading(false);
    }
  };

  useEffect(() => {
    if (selectedQueue) {
      loadQueueDetails();
      if (activeTab === 'peek') loadPeek();
      if (activeTab === 'dead') loadDeadLetters();
    }
  }, [selectedQueue, activeTab]);

  const handleCreateQueue = async (e) => {
    e.preventDefault();
    if (!newQueueName.trim() || createSubmitting) return;
    setCreateSubmitting(true);
    setErr(null);
    try {
      await api.queueCreate(
        newQueueName.trim(),
        {
          maxAttempts: Number(newMaxAttempts) || 5,
          visibilityTimeoutSeconds: Number(newVisTimeout) || 30,
        },
        headers,
      );
      setCreateModalOpen(false);
      const created = newQueueName.trim();
      setNewQueueName('');
      await loadQueues();
      setSelectedQueue(created);
    } catch (e) {
      setErr(e);
    } finally {
      setCreateSubmitting(false);
    }
  };

  const handleDeleteQueue = async (name) => {
    if (!window.confirm(`Delete queue "${name}" and all its messages?`)) return;
    try {
      await api.queueDelete(name, headers);
      if (selectedQueue === name) setSelectedQueue(null);
      await loadQueues();
    } catch (e) {
      setErr(e);
    }
  };

  const handlePurgeQueue = async () => {
    if (!selectedQueue) return;
    if (!window.confirm(`Purge all pending, in-flight, and dead-letter messages in "${selectedQueue}"?`)) return;
    try {
      await api.queuePurge(selectedQueue, headers);
      setLeased([]);
      await loadQueueDetails();
      if (activeTab === 'peek') await loadPeek();
      if (activeTab === 'dead') await loadDeadLetters();
    } catch (e) {
      setErr(e);
    }
  };

  const handlePublish = async (e) => {
    e.preventDefault();
    if (!selectedQueue || pubSubmitting) return;
    setPubSubmitting(true);
    setErr(null);
    try {
      const payload = JSON.parse(pubPayload);
      await api.queuePublish(
        selectedQueue,
        {
          payload,
          delaySeconds: Number(pubDelay) || 0,
          dedupeKey: pubDedupe.trim() || undefined,
        },
        headers,
      );
      setPublishModalOpen(false);
      setPubDedupe('');
      await loadQueueDetails();
      if (activeTab === 'peek') await loadPeek();
    } catch (e) {
      setErr(e);
    } finally {
      setPubSubmitting(false);
    }
  };

  const handleConsume = async () => {
    if (!selectedQueue || consumeLoading) return;
    setConsumeLoading(true);
    setErr(null);
    try {
      const res = await api.queueConsume(
        selectedQueue,
        {
          maxMessages: Number(consumeMax) || 5,
          visibilityTimeoutSeconds: Number(consumeTimeout) || 30,
          consumer: 'console-simulator',
        },
        headers,
      );
      const incoming = res?.messages || [];
      setLeased((prev) => [...incoming, ...prev]);
      await loadQueueDetails();
    } catch (e) {
      setErr(e);
    } finally {
      setConsumeLoading(false);
    }
  };

  const handleAck = async (receipt, id) => {
    try {
      await api.queueAck(selectedQueue, { receipt }, headers);
      setLeased((prev) => prev.filter((m) => m.receipt !== receipt));
      await loadQueueDetails();
    } catch (e) {
      setErr(e);
    }
  };

  const handleNack = async (receipt, requeue) => {
    try {
      await api.queueNack(
        selectedQueue,
        {
          receipt,
          requeue,
          error: requeue ? 'Console retry requested' : 'Manually dead-lettered from console',
        },
        headers,
      );
      setLeased((prev) => prev.filter((m) => m.receipt !== receipt));
      await loadQueueDetails();
      if (!requeue) await loadDeadLetters();
    } catch (e) {
      setErr(e);
    }
  };

  const handleHeartbeat = async (receipt) => {
    try {
      await api.queueHeartbeat(selectedQueue, { receipt, visibilityTimeoutSeconds: 60 }, headers);
      alert('Lease visibility extended by 60s');
    } catch (e) {
      setErr(e);
    }
  };

  const handleReplayDead = async (id) => {
    try {
      await api.queueReplayDead(selectedQueue, id, { resetAttempts: true }, headers);
      await loadDeadLetters();
      await loadQueueDetails();
    } catch (e) {
      setErr(e);
    }
  };

  const handleDeleteDead = async (id) => {
    try {
      await api.queueDeleteDead(selectedQueue, id, headers);
      await loadDeadLetters();
      await loadQueueDetails();
    } catch (e) {
      setErr(e);
    }
  };

  const filteredQueues = queues.filter((q) => {
    const name = q.queue || q.name || '';
    return name.toLowerCase().includes(queueSearch.toLowerCase());
  });

  return (
    <div>
      <PageTitle
        title="SynapseQueue"
        sub="Tenant-scoped message queue with at-least-once delivery, visibility timeouts, and dead letters."
        right={
          <div className="flex gap-2">
            <Btn kind="secondary" onClick={loadQueues} loading={loading}>
              <FontAwesomeIcon icon={faRotateRight} className="mr-1.5" /> Refresh
            </Btn>
            <Btn kind="primary" onClick={() => setCreateModalOpen(true)}>
              <FontAwesomeIcon icon={faPlus} className="mr-1.5" /> Declare Queue
            </Btn>
          </div>
        }
      />

      {err && <Err err={err} className="mb-6" />}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left column: Queues list */}
        <Card className="lg:col-span-1 p-4 flex flex-col h-[75vh]">
          <div className="mb-3">
            <h3 className="font-semibold text-sm text-main-text mb-2 flex items-center justify-between">
              <span>Queues</span>
              <Badge tone="blue">{queues.length}</Badge>
            </h3>
            <div className="relative">
              <FontAwesomeIcon
                icon={faMagnifyingGlass}
                className="absolute left-3 top-2.5 text-xs text-normal-text"
              />
              <input
                type="text"
                placeholder="Filter queues..."
                value={queueSearch}
                onChange={(e) => setQueueSearch(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 text-xs text-main-text outline-none focus:border-main-blue"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
            {loading && queues.length === 0 ? (
              <ListSkeleton rows={4} />
            ) : filteredQueues.length === 0 ? (
              <p className="text-xs text-normal-text text-center py-6">No queues found.</p>
            ) : (
              filteredQueues.map((q) => {
                const name = q.queue || q.name;
                const isSelected = name === selectedQueue;
                return (
                  <div
                    key={name}
                    onClick={() => setSelectedQueue(name)}
                    className={`p-3 rounded-2xl cursor-pointer transition-all border text-left flex items-start justify-between group ${
                      isSelected
                        ? 'border-main-blue bg-main-blue/10 text-main-blue font-medium shadow-sm'
                        : 'border-slate-100 hover:border-slate-200 hover:bg-slate-50 text-main-text'
                    }`}
                  >
                    <div className="min-w-0 pr-2">
                      <div className="flex items-center gap-1.5">
                        <FontAwesomeIcon icon={faInbox} className="text-xs" />
                        <span className="text-sm font-semibold truncate">{name}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-normal-text">
                        <span>vis: {q.visibilityTimeoutSeconds ?? 30}s</span>
                        <span>max: {q.maxAttempts ?? 5}x</span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteQueue(name);
                      }}
                      title="Delete queue"
                      className="opacity-0 group-hover:opacity-100 p-1 text-normal-text hover:text-red-500 transition-opacity"
                    >
                      <FontAwesomeIcon icon={faTrash} className="text-xs" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </Card>

        {/* Right column: Selected Queue Workspace */}
        <div className="lg:col-span-3">
          {!selectedQueue ? (
            <Card className="p-12 text-center">
              <Empty
                icon={<FontAwesomeIcon icon={faInbox} className="text-3xl text-main-blue mb-2" />}
                title="Select or declare a queue"
                sub="Pick a queue on the left to publish payloads, simulate worker consumption, or manage dead letters."
              />
            </Card>
          ) : (
            <div className="space-y-4">
              {/* Queue Stats Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Card className="p-4 text-center">
                  <span className="text-xs text-normal-text block">Pending Ready</span>
                  <span className="text-2xl font-bold text-main-blue mt-1 block">
                    {stats?.pending ?? stats?.ready ?? 0}
                  </span>
                </Card>
                <Card className="p-4 text-center">
                  <span className="text-xs text-normal-text block">In-Flight (Leased)</span>
                  <span className="text-2xl font-bold text-amber-500 mt-1 block">
                    {stats?.inflight ?? 0}
                  </span>
                </Card>
                <Card className="p-4 text-center">
                  <span className="text-xs text-normal-text block">Dead Letters</span>
                  <span className="text-2xl font-bold text-red-500 mt-1 block">
                    {stats?.dead ?? 0}
                  </span>
                </Card>
                <Card className="p-4 text-center">
                  <span className="text-xs text-normal-text block">Total Delivered</span>
                  <span className="text-2xl font-bold text-emerald-600 mt-1 block">
                    {stats?.delivered ?? stats?.ackCount ?? 0}
                  </span>
                </Card>
              </div>

              {/* Action Toolbar & Sub-tabs */}
              <Card className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold text-main-text">{selectedQueue}</h3>
                    <Badge tone="blue">Queue Active</Badge>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Btn kind="secondary" onClick={handlePurgeQueue} className="text-red-500 hover:text-red-600">
                      Purge All
                    </Btn>
                    <Btn kind="primary" onClick={() => setPublishModalOpen(true)}>
                      <FontAwesomeIcon icon={faPaperPlane} className="mr-1.5" /> Publish Message
                    </Btn>
                  </div>
                </div>

                {/* Sub-tabs */}
                <div className="flex gap-4 pt-3 text-sm">
                  {[
                    { id: 'peek', label: 'Pending Messages', icon: faInbox },
                    { id: 'consume', label: `Leased Worker Simulator (${leased.length})`, icon: faPlay },
                    { id: 'dead', label: `Dead-Letter Queue (${stats?.dead ?? deadLetters.length})`, icon: faSkull },
                  ].map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setActiveTab(t.id)}
                      className={`flex items-center gap-1.5 pb-1 border-b-2 font-medium transition-colors ${
                        activeTab === t.id
                          ? 'border-main-blue text-main-blue'
                          : 'border-transparent text-normal-text hover:text-main-text'
                      }`}
                    >
                      <FontAwesomeIcon icon={t.icon} className="text-xs" />
                      {t.label}
                    </button>
                  ))}
                </div>
              </Card>

              {/* Tab 1: Peek Messages */}
              {activeTab === 'peek' && (
                <Card className="p-4">
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="text-sm font-semibold text-main-text">Ready & Delayed Messages</h4>
                    <Btn kind="secondary" onClick={loadPeek} loading={peekLoading}>
                      <FontAwesomeIcon icon={faRotateRight} className="mr-1.5" /> Reload Peek
                    </Btn>
                  </div>

                  {peekLoading ? (
                    <TableSkeleton rows={4} />
                  ) : peekMessages.length === 0 ? (
                    <Empty
                      title="Queue is empty"
                      sub="Publish a message above or run a workflow producer to send work into this queue."
                    />
                  ) : (
                    <Table head={['Message ID', 'Attempts', 'Delay State', 'Payload Snippet', 'Created']}>
                      {peekMessages.map((m) => (
                        <tr key={m.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                          <td className="py-2.5 pr-3 font-mono text-xs font-semibold text-main-blue">{m.id}</td>
                          <td className="py-2.5 pr-3 text-xs">
                            <Badge tone={m.attempts > 1 ? 'amber' : 'gray'}>{m.attempts}x</Badge>
                          </td>
                          <td className="py-2.5 pr-3 text-xs text-normal-text">
                            {m.delayRemaining ? `${Math.round(m.delayRemaining)}s delay` : 'Ready'}
                          </td>
                          <td className="py-2.5 pr-3 font-mono text-xs text-normal-text max-w-sm truncate">
                            {JSON.stringify(m.payload)}
                          </td>
                          <td className="py-2.5 pr-3 text-xs text-normal-text whitespace-nowrap">
                            {m.createdAt ? new Date(m.createdAt).toLocaleTimeString() : 'now'}
                          </td>
                        </tr>
                      ))}
                    </Table>
                  )}
                </Card>
              )}

              {/* Tab 2: Leased Worker Simulator */}
              {activeTab === 'consume' && (
                <Card className="p-6 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-3">
                    <div>
                      <h4 className="font-semibold text-main-text">Worker Lease Simulator</h4>
                      <p className="text-xs text-normal-text mt-0.5">
                        Simulate a background consumer leasing work items. While leased, messages are in-flight and hidden from other workers.
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs text-normal-text">Timeout:</span>
                      <input
                        type="number"
                        value={consumeTimeout}
                        onChange={(e) => setConsumeTimeout(e.target.value)}
                        className="w-16 px-2 py-1 rounded-xl border border-slate-200 text-xs"
                      />
                      <Btn kind="primary" onClick={handleConsume} loading={consumeLoading}>
                        <FontAwesomeIcon icon={faPlay} className="mr-1.5" /> Lease Messages
                      </Btn>
                    </div>
                  </div>

                  {leased.length === 0 ? (
                    <Empty
                      title="No in-flight leases in simulator"
                      sub="Click 'Lease Messages' to fetch and lease pending items from the queue."
                    />
                  ) : (
                    <div className="space-y-3">
                      {leased.map((m) => (
                        <div key={m.receipt || m.id} className="p-4 rounded-2xl border border-slate-200 bg-slate-50/50 space-y-2">
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                            <div className="flex items-center gap-2 font-mono text-xs">
                              <span className="font-bold text-main-blue">{m.id}</span>
                              <Badge tone="amber">Attempt {m.attempts}</Badge>
                              {m.leaseExpiresAt && (
                                <span className="text-normal-text font-sans">
                                  Lease expires: {new Date(m.leaseExpiresAt).toLocaleTimeString()}
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => handleAck(m.receipt, m.id)}
                                title="Acknowledge (Success & Delete)"
                                className="px-2.5 py-1 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 font-medium text-xs flex items-center gap-1"
                              >
                                <FontAwesomeIcon icon={faCheck} /> Ack (Done)
                              </button>
                              <button
                                onClick={() => handleNack(m.receipt, true)}
                                title="Negative Ack (Requeue for retry)"
                                className="px-2.5 py-1 rounded-xl bg-amber-400/15 hover:bg-amber-400/25 text-amber-600 font-medium text-xs flex items-center gap-1"
                              >
                                <FontAwesomeIcon icon={faArrowsRotate} /> Nack (Retry)
                              </button>
                              <button
                                onClick={() => handleNack(m.receipt, false)}
                                title="Reject (Move to Dead Letter)"
                                className="px-2.5 py-1 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-500 font-medium text-xs flex items-center gap-1"
                              >
                                <FontAwesomeIcon icon={faSkull} /> Dead-Letter
                              </button>
                              <button
                                onClick={() => handleHeartbeat(m.receipt)}
                                title="Extend visibility deadline"
                                className="px-2 py-1 rounded-xl bg-slate-200 hover:bg-slate-300 text-main-text text-xs"
                              >
                                Extend
                              </button>
                            </div>
                          </div>

                          <pre className="p-3 bg-white rounded-xl border border-slate-100 font-mono text-xs text-main-text overflow-x-auto">
                            {JSON.stringify(m.payload, null, 2)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              )}

              {/* Tab 3: Dead Letters */}
              {activeTab === 'dead' && (
                <Card className="p-4">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h4 className="text-sm font-semibold text-main-text">Dead-Letter Queue (DLQ)</h4>
                      <p className="text-xs text-normal-text mt-0.5">
                        Messages that failed repeatedly or exceeded max retry attempts.
                      </p>
                    </div>
                    <Btn kind="secondary" onClick={loadDeadLetters} loading={deadLoading}>
                      <FontAwesomeIcon icon={faRotateRight} className="mr-1.5" /> Reload DLQ
                    </Btn>
                  </div>

                  {deadLoading ? (
                    <TableSkeleton rows={4} />
                  ) : deadLetters.length === 0 ? (
                    <Empty title="No dead letters" sub="All messages are being processed successfully!" />
                  ) : (
                    <Table head={['Message ID', 'Error / Reason', 'Attempts', 'Payload', 'Actions']}>
                      {deadLetters.map((d) => (
                        <tr key={d.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                          <td className="py-2.5 pr-3 font-mono text-xs font-semibold text-red-500">{d.id}</td>
                          <td className="py-2.5 pr-3 text-xs text-red-600 max-w-xs truncate">
                            {d.error || 'Max attempts reached'}
                          </td>
                          <td className="py-2.5 pr-3 text-xs">
                            <Badge tone="red">{d.attempts}x</Badge>
                          </td>
                          <td className="py-2.5 pr-3 font-mono text-xs text-normal-text max-w-sm truncate">
                            {JSON.stringify(d.payload)}
                          </td>
                          <td className="py-2.5 text-xs whitespace-nowrap flex items-center gap-1.5">
                            <button
                              onClick={() => handleReplayDead(d.id)}
                              title="Replay message back to pending"
                              className="px-2.5 py-1 rounded-xl bg-main-blue/10 hover:bg-main-blue/20 text-main-blue font-medium flex items-center gap-1"
                            >
                              <FontAwesomeIcon icon={faArrowsRotate} /> Replay
                            </button>
                            <button
                              onClick={() => handleDeleteDead(d.id)}
                              title="Permanently remove dead letter"
                              className="px-2 py-1 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-500"
                            >
                              <FontAwesomeIcon icon={faTrash} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </Table>
                  )}
                </Card>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Modal: Declare Queue */}
      {createModalOpen && (
        <Modal title="Declare SynapseQueue" onClose={() => setCreateModalOpen(false)}>
          <form onSubmit={handleCreateQueue} className="space-y-4">
            <Field label="Queue Name *">
              <Input
                required
                placeholder="e.g. emails, webhooks, analytics"
                value={newQueueName}
                onChange={(e) => setNewQueueName(e.target.value)}
              />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Max Attempts">
                <Input
                  type="number"
                  min="1"
                  max="100"
                  value={newMaxAttempts}
                  onChange={(e) => setNewMaxAttempts(e.target.value)}
                />
              </Field>

              <Field label="Visibility Timeout (Seconds)">
                <Input
                  type="number"
                  min="1"
                  max="3600"
                  value={newVisTimeout}
                  onChange={(e) => setNewVisTimeout(e.target.value)}
                />
              </Field>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Btn kind="secondary" onClick={() => setCreateModalOpen(false)}>
                Cancel
              </Btn>
              <Btn kind="primary" type="submit" loading={createSubmitting}>
                Declare Queue
              </Btn>
            </div>
          </form>
        </Modal>
      )}

      {/* Modal: Publish Message */}
      {publishModalOpen && (
        <Modal title={`Publish Message: ${selectedQueue}`} onClose={() => setPublishModalOpen(false)}>
          <form onSubmit={handlePublish} className="space-y-4">
            <Field label="Payload (JSON) *">
              <textarea
                rows={8}
                required
                value={pubPayload}
                onChange={(e) => setPubPayload(e.target.value)}
                className="w-full font-mono text-xs px-3 py-2 rounded-2xl border border-slate-200 outline-none focus:border-main-blue"
              />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Delay (Seconds, 0 = immediate)">
                <Input
                  type="number"
                  min="0"
                  value={pubDelay}
                  onChange={(e) => setPubDelay(e.target.value)}
                />
              </Field>

              <Field label="Deduplication Key (Optional)">
                <Input
                  placeholder="e.g. user:123:welcome"
                  value={pubDedupe}
                  onChange={(e) => setPubDedupe(e.target.value)}
                />
              </Field>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Btn kind="secondary" onClick={() => setPublishModalOpen(false)}>
                Cancel
              </Btn>
              <Btn kind="primary" type="submit" loading={pubSubmitting}>
                Publish
              </Btn>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
