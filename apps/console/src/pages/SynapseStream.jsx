/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faStream,
  faRotateRight,
  faPlus,
  faTrash,
  faPaperPlane,
  faPlay,
  faCheck,
  faClock,
  faUsers,
  faMagnifyingGlass,
  faLayerGroup,
  faBolt,
  faSliders,
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

const SAMPLE_EVENT_PAYLOAD = JSON.stringify(
  {
    sensorId: 'sensor-temp-01',
    metric: 'temperature',
    value: 26.8,
    unit: 'C',
    location: 'Building-A/Room-102',
  },
  null,
  2,
);

export default function SynapseStream() {
  const { headers } = useAuth();
  const [topics, setTopics] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [selectedTopic, setSelectedTopic] = useState(null);
  const [topicSearch, setQueueSearch] = useState('');
  const [activeTab, setActiveTab] = useState('events'); // 'events' | 'publish' | 'groups' | 'range'

  // Stats for the selected topic
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Events list
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [readFromId, setReadFromId] = useState('0-0');
  const [readCount, setReadCount] = useState(25);

  // Range Query
  const [rangeStart, setRangeStart] = useState('-');
  const [rangeEnd, setRangeEnd] = useState('+');
  const [rangeEvents, setRangeEvents] = useState([]);
  const [rangeLoading, setRangeLoading] = useState(false);

  // Consumer groups
  const [groups, setGroups] = useState([]);
  const [groupReadEvents, setGroupReadEvents] = useState([]);
  const [groupConsumerName, setGroupConsumerName] = useState('worker-1');
  const [selectedGroup, setSelectedGroup] = useState('');
  const [groupReading, setGroupReading] = useState(false);

  // Modals
  const [createTopicModalOpen, setCreateTopicModalOpen] = useState(false);
  const [newTopicName, setNewTopicName] = useState('');
  const [newMaxLen, setNewMaxLen] = useState(10000);
  const [createSubmitting, setCreateSubmitting] = useState(false);

  const [createGroupModalOpen, setCreateGroupModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupStartId, setNewGroupStartId] = useState('$');
  const [createGroupSubmitting, setCreateGroupSubmitting] = useState(false);

  // Publish Form
  const [pubPayload, setPubPayload] = useState(SAMPLE_EVENT_PAYLOAD);
  const [pubKey, setPubKey] = useState('sensor-temp-01');
  const [pubSubmitting, setPubSubmitting] = useState(false);
  const [pubSuccess, setPubSuccess] = useState(null);

  const loadSeq = useRef(0);

  const loadTopics = async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await api.streamTopicList(headers);
      if (seq === loadSeq.current) {
        const list = Array.isArray(res?.topics) ? res.topics : [];
        setTopics(list);
        if (list.length > 0 && !selectedTopic) {
          setSelectedTopic(list[0].name);
        } else if (list.length === 0) {
          setSelectedTopic(null);
        }
      }
    } catch (e) {
      if (seq === loadSeq.current) setErr(e);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    loadTopics();
  }, []);

  // Load stats and data when selectedTopic changes
  useEffect(() => {
    if (!selectedTopic) {
      setStats(null);
      setEvents([]);
      return;
    }
    loadStats(selectedTopic);
    loadEvents(selectedTopic);
  }, [selectedTopic]);

  const loadStats = async (tName) => {
    setStatsLoading(true);
    try {
      const res = await api.streamTopicStats(tName, headers);
      setStats(res?.stats || null);
      if (res?.stats?.groups) {
        setGroups(res.stats.groups);
        if (res.stats.groups.length > 0 && !selectedGroup) {
          setSelectedGroup(res.stats.groups[0].name);
        }
      }
    } catch {
      setStats(null);
    } finally {
      setStatsLoading(false);
    }
  };

  const loadEvents = async (tName, fromId = readFromId, count = readCount) => {
    setEventsLoading(true);
    try {
      const res = await api.streamRead(tName, { fromId: fromId || '0-0', count: Number(count) || 25 }, headers);
      setEvents(res?.events || []);
    } catch (e) {
      setEvents([]);
    } finally {
      setEventsLoading(false);
    }
  };

  const handleCreateTopic = async (e) => {
    e.preventDefault();
    if (!newTopicName.trim()) return;
    setCreateSubmitting(true);
    try {
      await api.streamTopicCreate(
        newTopicName.trim(),
        { maxLen: newMaxLen ? Number(newMaxLen) : undefined },
        headers,
      );
      setCreateTopicModalOpen(false);
      setNewTopicName('');
      await loadTopics();
      setSelectedTopic(newTopicName.trim());
    } catch (err) {
      alert(`Create topic failed: ${err.message || err}`);
    } finally {
      setCreateSubmitting(false);
    }
  };

  const handleDeleteTopic = async (tName) => {
    if (!confirm(`Are you sure you want to delete topic '${tName}' and all its streamed events?`)) return;
    try {
      await api.streamTopicDelete(tName, headers);
      if (selectedTopic === tName) setSelectedTopic(null);
      await loadTopics();
    } catch (err) {
      alert(`Delete topic failed: ${err.message || err}`);
    }
  };

  const handlePublish = async (e) => {
    e.preventDefault();
    if (!selectedTopic) return;
    setPubSubmitting(true);
    setPubSuccess(null);
    try {
      let parsed = null;
      try {
        parsed = JSON.parse(pubPayload);
      } catch {
        parsed = pubPayload;
      }
      const res = await api.streamPublish(
        selectedTopic,
        {
          payload: parsed,
          key: pubKey.trim() || undefined,
        },
        headers,
      );
      setPubSuccess(`Published successfully! Event ID: ${res?.event?.id}`);
      loadStats(selectedTopic);
      loadEvents(selectedTopic);
    } catch (err) {
      alert(`Publish failed: ${err.message || err}`);
    } finally {
      setPubSubmitting(false);
    }
  };

  const handleCreateGroup = async (e) => {
    e.preventDefault();
    if (!selectedTopic || !newGroupName.trim()) return;
    setCreateGroupSubmitting(true);
    try {
      await api.streamGroupCreate(
        selectedTopic,
        newGroupName.trim(),
        { startId: newGroupStartId || '$' },
        headers,
      );
      setCreateGroupModalOpen(false);
      setNewGroupName('');
      loadStats(selectedTopic);
    } catch (err) {
      alert(`Create group failed: ${err.message || err}`);
    } finally {
      setCreateGroupSubmitting(false);
    }
  };

  const handleGroupRead = async () => {
    if (!selectedTopic || !selectedGroup) return;
    setGroupReading(true);
    try {
      const res = await api.streamGroupRead(
        selectedTopic,
        selectedGroup,
        { consumer: groupConsumerName.trim() || 'worker-1', count: 5, autoAck: false },
        headers,
      );
      setGroupReadEvents(res?.events || []);
      loadStats(selectedTopic);
    } catch (err) {
      alert(`Group read failed: ${err.message || err}`);
    } finally {
      setGroupReading(false);
    }
  };

  const handleGroupAck = async (id) => {
    if (!selectedTopic || !selectedGroup) return;
    try {
      await api.streamGroupAck(selectedTopic, selectedGroup, { ids: [id] }, headers);
      setGroupReadEvents((prev) => prev.filter((ev) => ev.id !== id));
      loadStats(selectedTopic);
    } catch (err) {
      alert(`Ack failed: ${err.message || err}`);
    }
  };

  const handleQueryRange = async (e) => {
    e?.preventDefault();
    if (!selectedTopic) return;
    setRangeLoading(true);
    try {
      const res = await api.streamRange(selectedTopic, { start: rangeStart, end: rangeEnd, count: 50 }, headers);
      setRangeEvents(res?.events || []);
    } catch (err) {
      setRangeEvents([]);
    } finally {
      setRangeLoading(false);
    }
  };

  const filteredTopics = topics.filter((t) => t.name.toLowerCase().includes(topicSearch.toLowerCase()));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <PageTitle
            title="SynapseStream"
            subtitle="Pluggable Event Streaming Engine (Kafka-like Redis Streams / Kafka)"
          />
        </div>
        <div className="flex items-center gap-2">
          <Btn variant="outline" onClick={loadTopics} disabled={loading}>
            <FontAwesomeIcon icon={faRotateRight} className={loading ? 'animate-spin' : ''} />
            Refresh
          </Btn>
          <Btn variant="primary" onClick={() => setCreateTopicModalOpen(true)}>
            <FontAwesomeIcon icon={faPlus} />
            Create Topic
          </Btn>
        </div>
      </div>

      <Err error={err} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Topics List */}
        <div className="lg:col-span-4 space-y-4">
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="relative flex-1">
                <FontAwesomeIcon
                  icon={faMagnifyingGlass}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs"
                />
                <input
                  type="text"
                  placeholder="Filter topics..."
                  value={topicSearch}
                  onChange={(e) => setQueueSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-main-blue"
                />
              </div>
            </div>

            {loading && topics.length === 0 ? (
              <ListSkeleton count={4} />
            ) : filteredTopics.length === 0 ? (
              <Empty
                icon={faStream}
                title="No topics found"
                desc="Create your first event stream topic to begin publishing sensor telemetry."
              />
            ) : (
              <div className="space-y-1.5 max-h-[600px] overflow-y-auto pr-1">
                {filteredTopics.map((t) => {
                  const active = selectedTopic === t.name;
                  return (
                    <div
                      key={t.name}
                      onClick={() => setSelectedTopic(t.name)}
                      className={`p-3 rounded-2xl cursor-pointer transition-all border ${
                        active
                          ? 'bg-amber-500/10 border-amber-500/30 shadow-sm'
                          : 'bg-white hover:bg-slate-50 border-slate-100'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-sm text-slate-800 truncate">{t.name}</span>
                        {t.maxLen && (
                          <Badge variant="neutral" className="text-[10px]">
                            cap: {t.maxLen}
                          </Badge>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1 flex items-center justify-between">
                        <span>Created {new Date(t.createdAt).toLocaleDateString()}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteTopic(t.name);
                          }}
                          className="text-slate-400 hover:text-red-500 transition-colors p-1"
                          title="Delete topic"
                        >
                          <FontAwesomeIcon icon={faTrash} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {/* Right: Topic Details & Operations */}
        <div className="lg:col-span-8 space-y-4">
          {selectedTopic ? (
            <>
              {/* Stats Card */}
              <Card className="p-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-bold text-slate-900">{selectedTopic}</h2>
                      <Badge variant="success">Active Stream</Badge>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Distributed Append-Only Commit Log
                    </p>
                  </div>
                  <Btn
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      loadStats(selectedTopic);
                      loadEvents(selectedTopic);
                    }}
                    disabled={statsLoading}
                  >
                    <FontAwesomeIcon icon={faRotateRight} className={statsLoading ? 'animate-spin' : ''} />
                    Refresh Stats
                  </Btn>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
                  <div className="p-3 bg-slate-50 rounded-2xl">
                    <span className="text-[11px] text-slate-500 uppercase font-semibold">Total Events</span>
                    <p className="text-2xl font-bold text-slate-800 mt-0.5">{stats?.length ?? '-'}</p>
                  </div>
                  <div className="p-3 bg-slate-50 rounded-2xl">
                    <span className="text-[11px] text-slate-500 uppercase font-semibold">Consumer Groups</span>
                    <p className="text-2xl font-bold text-slate-800 mt-0.5">{stats?.groupsCount ?? '0'}</p>
                  </div>
                  <div className="p-3 bg-slate-50 rounded-2xl">
                    <span className="text-[11px] text-slate-500 uppercase font-semibold">First Event ID</span>
                    <p className="text-xs font-mono text-slate-700 truncate mt-1.5">{stats?.firstId || 'None'}</p>
                  </div>
                  <div className="p-3 bg-slate-50 rounded-2xl">
                    <span className="text-[11px] text-slate-500 uppercase font-semibold">Last Event ID</span>
                    <p className="text-xs font-mono text-slate-700 truncate mt-1.5">{stats?.lastId || 'None'}</p>
                  </div>
                </div>
              </Card>

              {/* Tabs */}
              <div className="flex border-b border-slate-200 gap-6">
                <button
                  onClick={() => setActiveTab('events')}
                  className={`pb-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                    activeTab === 'events'
                      ? 'border-amber-500 text-amber-600 font-semibold'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <FontAwesomeIcon icon={faStream} className="mr-2" />
                  Live Stream Tail
                </button>
                <button
                  onClick={() => setActiveTab('publish')}
                  className={`pb-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                    activeTab === 'publish'
                      ? 'border-amber-500 text-amber-600 font-semibold'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <FontAwesomeIcon icon={faPaperPlane} className="mr-2" />
                  Publish Event
                </button>
                <button
                  onClick={() => setActiveTab('groups')}
                  className={`pb-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                    activeTab === 'groups'
                      ? 'border-amber-500 text-amber-600 font-semibold'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <FontAwesomeIcon icon={faUsers} className="mr-2" />
                  Consumer Groups ({stats?.groupsCount || 0})
                </button>
                <button
                  onClick={() => setActiveTab('range')}
                  className={`pb-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                    activeTab === 'range'
                      ? 'border-amber-500 text-amber-600 font-semibold'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <FontAwesomeIcon icon={faClock} className="mr-2" />
                  Time-Range Replay
                </button>
              </div>

              {/* Tab 1: Live Stream Tail */}
              {activeTab === 'events' && (
                <Card className="p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">From ID:</span>
                      <input
                        type="text"
                        value={readFromId}
                        onChange={(e) => setReadFromId(e.target.value)}
                        className="w-32 px-2.5 py-1 text-xs bg-slate-50 border border-slate-200 rounded-lg font-mono"
                        placeholder="0-0 or ID"
                      />
                      <Btn
                        variant="outline"
                        size="sm"
                        onClick={() => loadEvents(selectedTopic, readFromId, readCount)}
                        disabled={eventsLoading}
                      >
                        Fetch
                      </Btn>
                    </div>
                    <span className="text-xs text-slate-400">Non-destructive read (Multi-reader fanout)</span>
                  </div>

                  {eventsLoading ? (
                    <TableSkeleton rows={4} cols={3} />
                  ) : events.length === 0 ? (
                    <Empty
                      icon={faStream}
                      title="No events yet"
                      desc="Stream is currently empty or no events match the offset."
                    />
                  ) : (
                    <div className="space-y-2">
                      {events.map((ev) => (
                        <div key={ev.id} className="p-3 bg-slate-50 rounded-xl border border-slate-100 text-xs space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="font-mono font-bold text-amber-700">{ev.id}</span>
                            <span className="text-slate-400">{new Date(ev.timestamp).toLocaleTimeString()}</span>
                          </div>
                          {ev.key && (
                            <div className="text-[11px] text-slate-600 font-medium">Key: {ev.key}</div>
                          )}
                          <pre className="bg-slate-900 text-amber-300 p-2.5 rounded-lg overflow-x-auto text-[11px] font-mono max-h-40">
                            {JSON.stringify(ev.payload, null, 2)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              )}

              {/* Tab 2: Publish Event */}
              {activeTab === 'publish' && (
                <Card className="p-5">
                  <form onSubmit={handlePublish} className="space-y-4">
                    <Field label="Routing Key (Optional)" desc="Used for device partitioning or hashing">
                      <Input
                        value={pubKey}
                        onChange={(e) => setPubKey(e.target.value)}
                        placeholder="e.g. sensor-01"
                      />
                    </Field>

                    <Field label="JSON Payload" desc="Telemetry, observation or structured event">
                      <textarea
                        rows={7}
                        value={pubPayload}
                        onChange={(e) => setPubPayload(e.target.value)}
                        className="w-full font-mono text-xs bg-slate-900 text-slate-100 p-3 rounded-xl border border-slate-800 focus:outline-none"
                      />
                    </Field>

                    {pubSuccess && (
                      <div className="p-3 bg-emerald-50 text-emerald-800 rounded-xl text-xs font-medium border border-emerald-200">
                        {pubSuccess}
                      </div>
                    )}

                    <Btn variant="primary" type="submit" disabled={pubSubmitting}>
                      <FontAwesomeIcon icon={faPaperPlane} />
                      {pubSubmitting ? 'Publishing...' : 'Publish to Stream'}
                    </Btn>
                  </form>
                </Card>
              )}

              {/* Tab 3: Consumer Groups */}
              {activeTab === 'groups' && (
                <Card className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-bold text-sm text-slate-900">Consumer Groups</h3>
                      <p className="text-xs text-slate-500">
                        Distribute stream partitions across multiple workers with offset tracking
                      </p>
                    </div>
                    <Btn variant="primary" size="sm" onClick={() => setCreateGroupModalOpen(true)}>
                      <FontAwesomeIcon icon={faPlus} />
                      New Group
                    </Btn>
                  </div>

                  {groups.length === 0 ? (
                    <Empty
                      icon={faUsers}
                      title="No Consumer Groups"
                      desc="Create a consumer group to enable horizontal scaling and worker leases."
                    />
                  ) : (
                    <div className="space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {groups.map((g) => (
                          <div
                            key={g.name}
                            onClick={() => setSelectedGroup(g.name)}
                            className={`p-3 rounded-xl border cursor-pointer ${
                              selectedGroup === g.name
                                ? 'bg-amber-50 border-amber-300'
                                : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-bold text-xs text-slate-800">{g.name}</span>
                              <Badge variant="neutral" className="text-[10px]">
                                {g.consumers} consumer(s)
                              </Badge>
                            </div>
                            <div className="text-[11px] text-slate-500 mt-1">
                              Pending: {g.pending} | Last delivered: <span className="font-mono">{g.lastDeliveredId}</span>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Worker Simulation */}
                      {selectedGroup && (
                        <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-3 mt-4">
                          <h4 className="font-bold text-xs text-slate-800">
                            Simulate Worker Consume ({selectedGroup})
                          </h4>
                          <div className="flex items-center gap-3">
                            <input
                              type="text"
                              value={groupConsumerName}
                              onChange={(e) => setGroupConsumerName(e.target.value)}
                              placeholder="Consumer Name"
                              className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-xl"
                            />
                            <Btn variant="primary" size="sm" onClick={handleGroupRead} disabled={groupReading}>
                              <FontAwesomeIcon icon={faPlay} />
                              Read Batch (XREADGROUP)
                            </Btn>
                          </div>

                          {groupReadEvents.length > 0 && (
                            <div className="space-y-2 mt-3">
                              <span className="text-xs font-semibold text-slate-700">Leased Messages:</span>
                              {groupReadEvents.map((ev) => (
                                <div
                                  key={ev.id}
                                  className="p-2.5 bg-white rounded-xl border border-slate-200 flex items-center justify-between text-xs"
                                >
                                  <div>
                                    <span className="font-mono font-bold text-amber-700 mr-2">{ev.id}</span>
                                    <span className="text-slate-600">{JSON.stringify(ev.payload).slice(0, 50)}...</span>
                                  </div>
                                  <Btn variant="success" size="sm" onClick={() => handleGroupAck(ev.id)}>
                                    <FontAwesomeIcon icon={faCheck} /> Ack
                                  </Btn>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              )}

              {/* Tab 4: Time-Range Replay */}
              {activeTab === 'range' && (
                <Card className="p-5 space-y-4">
                  <div>
                    <h3 className="font-bold text-sm text-slate-900">Historical Time-Range Replay</h3>
                    <p className="text-xs text-slate-500">
                      Query sensor observations between arbitrary start and end IDs (XRANGE)
                    </p>
                  </div>

                  <form onSubmit={handleQueryRange} className="flex flex-wrap items-center gap-3">
                    <div>
                      <span className="text-xs text-slate-500 block mb-1">Start ID / '-'</span>
                      <input
                        type="text"
                        value={rangeStart}
                        onChange={(e) => setRangeStart(e.target.value)}
                        className="px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-xl font-mono"
                      />
                    </div>
                    <div>
                      <span className="text-xs text-slate-500 block mb-1">End ID / '+'</span>
                      <input
                        type="text"
                        value={rangeEnd}
                        onChange={(e) => setRangeEnd(e.target.value)}
                        className="px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-xl font-mono"
                      />
                    </div>
                    <div className="self-end">
                      <Btn variant="primary" type="submit" disabled={rangeLoading}>
                        Replay Range
                      </Btn>
                    </div>
                  </form>

                  {rangeLoading ? (
                    <TableSkeleton rows={3} cols={2} />
                  ) : rangeEvents.length > 0 ? (
                    <div className="space-y-2">
                      {rangeEvents.map((ev) => (
                        <div key={ev.id} className="p-3 bg-slate-50 rounded-xl border border-slate-100 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="font-mono font-bold text-amber-700">{ev.id}</span>
                            <span className="text-slate-400">{new Date(ev.timestamp).toISOString()}</span>
                          </div>
                          <pre className="mt-1 bg-slate-900 text-slate-100 p-2 rounded-lg text-[11px] font-mono">
                            {JSON.stringify(ev.payload, null, 2)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400 italic">No events matched the range query.</p>
                  )}
                </Card>
              )}
            </>
          ) : (
            <Card className="p-8">
              <Empty
                icon={faStream}
                title="Select a topic"
                desc="Choose a stream topic on the left or create a new one to view events and manage consumer groups."
              />
            </Card>
          )}
        </div>
      </div>

      {/* Modal Create Topic */}
      <Modal
        open={createTopicModalOpen}
        onClose={() => setCreateTopicModalOpen(false)}
        title="Create Stream Topic"
      >
        <form onSubmit={handleCreateTopic} className="space-y-4">
          <Field label="Topic Name" desc="Unique stream topic identifier">
            <Input
              value={newTopicName}
              onChange={(e) => setNewTopicName(e.target.value)}
              placeholder="e.g. sensor-telemetry"
              required
            />
          </Field>
          <Field label="Max Length Retention" desc="Maximum number of events to retain (trims oldest)">
            <Input
              type="number"
              value={newMaxLen}
              onChange={(e) => setNewMaxLen(e.target.value)}
              placeholder="10000"
            />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Btn variant="outline" type="button" onClick={() => setCreateTopicModalOpen(false)}>
              Cancel
            </Btn>
            <Btn variant="primary" type="submit" disabled={createSubmitting}>
              {createSubmitting ? 'Creating...' : 'Create Topic'}
            </Btn>
          </div>
        </form>
      </Modal>

      {/* Modal Create Consumer Group */}
      <Modal
        open={createGroupModalOpen}
        onClose={() => setCreateGroupModalOpen(false)}
        title="Create Consumer Group"
      >
        <form onSubmit={handleCreateGroup} className="space-y-4">
          <Field label="Group Name" desc="Consumer group identifier">
            <Input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="e.g. db-ingestors"
              required
            />
          </Field>
          <Field label="Start Offset ID" desc="'$' for new messages only, or '0-0' to replay from beginning">
            <Input
              value={newGroupStartId}
              onChange={(e) => setNewGroupStartId(e.target.value)}
              placeholder="$"
            />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Btn variant="outline" type="button" onClick={() => setCreateGroupModalOpen(false)}>
              Cancel
            </Btn>
            <Btn variant="primary" type="submit" disabled={createGroupSubmitting}>
              {createGroupSubmitting ? 'Creating...' : 'Create Group'}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
