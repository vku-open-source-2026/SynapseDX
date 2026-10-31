/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faDatabase,
  faPlus,
  faTrash,
  faRotateRight,
  faMagnifyingGlass,
  faCode,
  faList,
  faArrowRight,
  faArrowUpRightFromSquare,
  faPen,
  faBolt,
  faClock,
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
  Spinner,
} from '../components/ui.jsx';

const SAMPLE_MAPPING = JSON.stringify(
  {
    fields: {
      name: { path: 'profile.name', type: 'string', required: true },
      capacity: { path: 'profile.capacity', type: 'number' },
      tags: { path: 'profile.tags', type: 'array' },
    },
    additional: false,
  },
  null,
  2,
);

const SAMPLE_DOC = JSON.stringify(
  {
    name: 'Central Park',
    capacity: 150,
    tags: ['recreation', 'nature'],
  },
  null,
  2,
);

export default function SynapseBase() {
  const { headers } = useAuth();
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [selectedCol, setSelectedCol] = useState(null);
  const [colSearch, setColSearch] = useState('');
  const [activeTab, setActiveTab] = useState('documents'); // 'documents' | 'mapping' | 'query' | 'changes'

  // Documents state
  const [docs, setDocs] = useState([]);
  const [docsTotal, setDocsTotal] = useState(0);
  const [docsLoading, setDocsLoading] = useState(false);
  const [viewMode, setViewMode] = useState('object'); // 'object' | 'data'
  const [docSearch, setDocSearch] = useState('');

  // Modals
  const [createColOpen, setCreateColOpen] = useState(false);
  const [newColName, setNewColName] = useState('');
  const [newColDesc, setNewColDesc] = useState('');
  const [newColMapping, setNewColMapping] = useState(SAMPLE_MAPPING);
  const [colSubmitting, setColSubmitting] = useState(false);

  const [docModalOpen, setDocModalOpen] = useState(false);
  const [editingDocId, setEditingDocId] = useState('');
  const [docPayload, setDocPayload] = useState(SAMPLE_DOC);
  const [docMode, setDocMode] = useState('object');
  const [docSubmitting, setDocSubmitting] = useState(false);

  const [incrModalOpen, setIncrModalOpen] = useState(false);
  const [incrDocId, setIncrDocId] = useState('');
  const [incrField, setIncrField] = useState('profile.capacity');
  const [incrBy, setIncrBy] = useState(1);
  const [incrSubmitting, setIncrSubmitting] = useState(false);

  // Mapping state for editing
  const [mappingDraft, setMappingDraft] = useState('');
  const [mappingSaving, setMappingSaving] = useState(false);
  const [mappingMsg, setMappingMsg] = useState(null);

  // Query engine state
  const [queryWhere, setQueryWhere] = useState('{\n  "capacity": { "gte": 0 }\n}');
  const [queryOrderBy, setQueryOrderBy] = useState('name');
  const [queryOrderDir, setQueryOrderDir] = useState('asc');
  const [queryResult, setQueryResult] = useState(null);
  const [queryRunning, setQueryRunning] = useState(false);

  // Change feed state
  const [changes, setChanges] = useState([]);
  const [changesLoading, setChangesLoading] = useState(false);

  const loadSeq = useRef(0);

  const loadCollections = async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await api.baseCollections(headers);
      if (seq === loadSeq.current) {
        const list = Array.isArray(res) ? res : [];
        setCollections(list);
        if (list.length > 0 && !selectedCol) {
          setSelectedCol(list[0].name);
        } else if (list.length === 0) {
          setSelectedCol(null);
        }
      }
    } catch (e) {
      if (seq === loadSeq.current) setErr(e);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    loadCollections();
  }, [headers]);

  const currentCollection = collections.find((c) => c.name === selectedCol);

  // Sync mapping draft when collection changes
  useEffect(() => {
    if (currentCollection) {
      setMappingDraft(JSON.stringify(currentCollection.mapping || {}, null, 2));
      setMappingMsg(null);
    }
  }, [selectedCol, collections]);

  const loadDocs = async () => {
    if (!selectedCol) return;
    setDocsLoading(true);
    try {
      if (viewMode === 'object') {
        const qRes = await api.baseQuery(selectedCol, { as: 'object', limit: 50 }, headers);
        setDocs(qRes?.items || []);
        setDocsTotal(qRes?.total ?? (qRes?.items?.length || 0));
      } else {
        const res = await api.baseDocuments(selectedCol, { limit: 50 }, headers);
        setDocs(res?.items || []);
        setDocsTotal(res?.total ?? (res?.items?.length || 0));
      }
    } catch (e) {
      setErr(e);
    } finally {
      setDocsLoading(false);
    }
  };

  useEffect(() => {
    if (selectedCol) {
      loadDocs();
      if (activeTab === 'changes') loadChanges();
    }
  }, [selectedCol, viewMode, activeTab]);

  const loadChanges = async () => {
    if (!selectedCol) return;
    setChangesLoading(true);
    try {
      const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const res = await api.baseChanges(selectedCol, { since: past, limit: 30 }, headers);
      setChanges(res?.changes || []);
    } catch (e) {
      setErr(e);
    } finally {
      setChangesLoading(false);
    }
  };

  const handleCreateCollection = async (e) => {
    e.preventDefault();
    if (!newColName.trim() || colSubmitting) return;
    setColSubmitting(true);
    setErr(null);
    try {
      let mapping = undefined;
      if (newColMapping.trim()) {
        mapping = JSON.parse(newColMapping);
      }
      await api.baseCreateCollection(
        {
          name: newColName.trim(),
          description: newColDesc.trim() || undefined,
          mapping,
        },
        headers,
      );
      setCreateColOpen(false);
      setNewColName('');
      setNewColDesc('');
      await loadCollections();
      setSelectedCol(newColName.trim());
    } catch (e) {
      setErr(e);
    } finally {
      setColSubmitting(false);
    }
  };

  const handleDeleteCollection = async (name) => {
    if (!window.confirm(`Delete collection "${name}" and all its documents?`)) return;
    try {
      await api.baseDeleteCollection(name, headers);
      if (selectedCol === name) setSelectedCol(null);
      await loadCollections();
    } catch (e) {
      setErr(e);
    }
  };

  const handleSaveDoc = async (e) => {
    e.preventDefault();
    if (docSubmitting || !selectedCol) return;
    setDocSubmitting(true);
    setErr(null);
    try {
      const parsed = JSON.parse(docPayload);
      const body = { [docMode]: parsed };
      if (editingDocId) {
        await api.baseUpdateDocument(selectedCol, editingDocId, body, headers);
      } else {
        await api.baseCreateDocument(selectedCol, body, headers);
      }
      setDocModalOpen(false);
      setEditingDocId('');
      await loadDocs();
    } catch (e) {
      setErr(e);
    } finally {
      setDocSubmitting(false);
    }
  };

  const handleDeleteDoc = async (id) => {
    if (!window.confirm(`Delete document "${id}"?`)) return;
    try {
      await api.baseDeleteDocument(selectedCol, id, headers);
      await loadDocs();
    } catch (e) {
      setErr(e);
    }
  };

  const handleIncrement = async (e) => {
    e.preventDefault();
    if (incrSubmitting || !selectedCol || !incrDocId) return;
    setIncrSubmitting(true);
    setErr(null);
    try {
      await api.baseIncrement(selectedCol, incrDocId, { field: incrField, by: Number(incrBy) }, headers);
      setIncrModalOpen(false);
      await loadDocs();
    } catch (e) {
      setErr(e);
    } finally {
      setIncrSubmitting(false);
    }
  };

  const handleSaveMapping = async () => {
    if (!selectedCol || mappingSaving) return;
    setMappingSaving(true);
    setMappingMsg(null);
    try {
      const parsed = JSON.parse(mappingDraft);
      await api.baseUpdateCollection(selectedCol, { mapping: parsed }, headers);
      setMappingMsg({ type: 'success', text: 'Mapping updated successfully.' });
      await loadCollections();
    } catch (e) {
      setMappingMsg({ type: 'error', text: e.message || String(e) });
    } finally {
      setMappingSaving(false);
    }
  };

  const handleRunQuery = async (e) => {
    e.preventDefault();
    if (!selectedCol || queryRunning) return;
    setQueryRunning(true);
    try {
      const where = queryWhere.trim() ? JSON.parse(queryWhere) : undefined;
      const res = await api.baseQuery(
        selectedCol,
        {
          where,
          orderBy: queryOrderBy ? [{ field: queryOrderBy, direction: queryOrderDir }] : undefined,
          as: viewMode,
          limit: 30,
        },
        headers,
      );
      setQueryResult(res);
    } catch (e) {
      setQueryResult({ error: e.message || String(e) });
    } finally {
      setQueryRunning(false);
    }
  };

  const filteredCollections = collections.filter((c) =>
    c.name.toLowerCase().includes(colSearch.toLowerCase()) ||
    (c.description || '').toLowerCase().includes(colSearch.toLowerCase()),
  );

  const filteredDocs = docs.filter((d) =>
    !docSearch.trim() || d.id.toLowerCase().includes(docSearch.toLowerCase()) ||
    JSON.stringify(d.object || d.data || {}).toLowerCase().includes(docSearch.toLowerCase()),
  );

  return (
    <div>
      <PageTitle
        title="SynapseBase"
        sub="Self-managed document database with logical object ↔ data mapping, queries, and atomic counters."
        right={
          <div className="flex gap-2">
            <Btn kind="secondary" onClick={loadCollections} loading={loading}>
              <FontAwesomeIcon icon={faRotateRight} className="mr-1.5" /> Refresh
            </Btn>
            <Btn kind="primary" onClick={() => setCreateColOpen(true)}>
              <FontAwesomeIcon icon={faPlus} className="mr-1.5" /> New Collection
            </Btn>
          </div>
        }
      />

      {err && <Err err={err} className="mb-6" />}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left column: Collections list */}
        <Card className="lg:col-span-1 p-4 flex flex-col h-[75vh]">
          <div className="mb-3">
            <h3 className="font-semibold text-sm text-main-text mb-2 flex items-center justify-between">
              <span>Collections</span>
              <Badge tone="blue">{collections.length}</Badge>
            </h3>
            <div className="relative">
              <FontAwesomeIcon
                icon={faMagnifyingGlass}
                className="absolute left-3 top-2.5 text-xs text-normal-text"
              />
              <input
                type="text"
                placeholder="Filter collections..."
                value={colSearch}
                onChange={(e) => setColSearch(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 text-xs text-main-text outline-none focus:border-main-blue"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
            {loading && collections.length === 0 ? (
              <ListSkeleton rows={4} />
            ) : filteredCollections.length === 0 ? (
              <p className="text-xs text-normal-text text-center py-6">No collections found.</p>
            ) : (
              filteredCollections.map((col) => {
                const isSelected = col.name === selectedCol;
                return (
                  <div
                    key={col.name}
                    onClick={() => setSelectedCol(col.name)}
                    className={`p-3 rounded-2xl cursor-pointer transition-all border text-left flex items-start justify-between group ${
                      isSelected
                        ? 'border-main-blue bg-main-blue/10 text-main-blue font-medium shadow-sm'
                        : 'border-slate-100 hover:border-slate-200 hover:bg-slate-50 text-main-text'
                    }`}
                  >
                    <div className="min-w-0 pr-2">
                      <div className="flex items-center gap-1.5">
                        <FontAwesomeIcon icon={faDatabase} className="text-xs" />
                        <span className="text-sm font-semibold truncate">{col.name}</span>
                      </div>
                      {col.description && (
                        <p className="text-xs text-normal-text truncate mt-0.5">{col.description}</p>
                      )}
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-normal-text">
                        <span>{col.stats?.documentCount ?? 0} docs</span>
                        {col.mapping?.fields && <span>· mapped</span>}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteCollection(col.name);
                      }}
                      title="Delete collection"
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

        {/* Right column: Selected Collection Workspace */}
        <div className="lg:col-span-3">
          {!selectedCol ? (
            <Card className="p-12 text-center">
              <Empty
                icon={<FontAwesomeIcon icon={faDatabase} className="text-3xl text-main-blue mb-2" />}
                title="Select or create a collection"
                sub="Choose a collection on the left to browse documents, customize object mappings, or run queries."
              />
            </Card>
          ) : (
            <div className="space-y-4">
              {/* Collection header & stats */}
              <Card className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold text-main-text">{selectedCol}</h3>
                      <Badge tone={currentCollection?.mapping ? 'green' : 'gray'}>
                        {currentCollection?.mapping ? 'Object Mapping Active' : 'Raw JSON'}
                      </Badge>
                    </div>
                    {currentCollection?.description && (
                      <p className="text-xs text-normal-text mt-0.5">{currentCollection.description}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {/* View Mode Toggle */}
                    <div className="bg-slate-100 p-0.5 rounded-2xl flex text-xs">
                      <button
                        onClick={() => setViewMode('object')}
                        className={`px-3 py-1 rounded-xl transition-all ${
                          viewMode === 'object' ? 'bg-white font-medium text-main-blue shadow-sm' : 'text-normal-text'
                        }`}
                      >
                        Logical Object
                      </button>
                      <button
                        onClick={() => setViewMode('data')}
                        className={`px-3 py-1 rounded-xl transition-all ${
                          viewMode === 'data' ? 'bg-white font-medium text-main-blue shadow-sm' : 'text-normal-text'
                        }`}
                      >
                        Raw Data
                      </button>
                    </div>

                    <Btn
                      kind="primary"
                      onClick={() => {
                        setEditingDocId('');
                        setDocPayload(SAMPLE_DOC);
                        setDocModalOpen(true);
                      }}
                    >
                      <FontAwesomeIcon icon={faPlus} className="mr-1.5" /> Add Document
                    </Btn>
                  </div>
                </div>

                {/* Sub-tabs */}
                <div className="flex gap-4 pt-3 text-sm">
                  {[
                    { id: 'documents', label: `Documents (${docsTotal})`, icon: faList },
                    { id: 'mapping', label: 'Object Mapping', icon: faCode },
                    { id: 'query', label: 'Query Runner', icon: faBolt },
                    { id: 'changes', label: 'Change Feed', icon: faClock },
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

              {/* Tab 1: Documents list */}
              {activeTab === 'documents' && (
                <Card className="p-4">
                  <div className="flex items-center justify-between gap-3 mb-4">
                    <div className="relative max-w-sm w-full">
                      <FontAwesomeIcon
                        icon={faMagnifyingGlass}
                        className="absolute left-3 top-2.5 text-xs text-normal-text"
                      />
                      <input
                        type="text"
                        placeholder="Search document ID or content..."
                        value={docSearch}
                        onChange={(e) => setDocSearch(e.target.value)}
                        className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 text-xs text-main-text outline-none focus:border-main-blue"
                      />
                    </div>
                    <Btn kind="secondary" onClick={loadDocs} loading={docsLoading}>
                      <FontAwesomeIcon icon={faRotateRight} className="mr-1.5" /> Reload
                    </Btn>
                  </div>

                  {docsLoading ? (
                    <TableSkeleton rows={5} />
                  ) : filteredDocs.length === 0 ? (
                    <Empty
                      title="No documents in collection"
                      sub="Click 'Add Document' to write the first record into this collection."
                    />
                  ) : (
                    <Table head={['Document ID', 'Version', 'Payload (' + viewMode + ')', 'Updated', 'Actions']}>
                      {filteredDocs.map((doc) => {
                        const content = viewMode === 'object' ? doc.object ?? doc.data : doc.data ?? doc.object;
                        const preview = JSON.stringify(content);
                        return (
                          <tr key={doc.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                            <td className="py-2.5 pr-3 font-mono text-xs font-semibold text-main-blue truncate max-w-44">
                              {doc.id}
                            </td>
                            <td className="py-2.5 pr-3 text-xs">
                              <Badge tone="gray">v{doc.version}</Badge>
                            </td>
                            <td className="py-2.5 pr-3 font-mono text-xs text-normal-text max-w-md truncate">
                              {preview}
                            </td>
                            <td className="py-2.5 pr-3 text-xs text-normal-text whitespace-nowrap">
                              {new Date(doc.updatedAt || doc.createdAt).toLocaleTimeString()}
                            </td>
                            <td className="py-2.5 text-xs whitespace-nowrap flex items-center gap-1.5">
                              <button
                                onClick={() => {
                                  setEditingDocId(doc.id);
                                  setDocPayload(JSON.stringify(content, null, 2));
                                  setDocMode(viewMode);
                                  setDocModalOpen(true);
                                }}
                                title="Edit document"
                                className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-main-text"
                              >
                                <FontAwesomeIcon icon={faPen} className="text-xs" />
                              </button>
                              <button
                                onClick={() => {
                                  setIncrDocId(doc.id);
                                  setIncrModalOpen(true);
                                }}
                                title="Atomic Counter increment"
                                className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-main-text"
                              >
                                +1
                              </button>
                              <button
                                onClick={() => handleDeleteDoc(doc.id)}
                                title="Delete document"
                                className="px-2 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-500"
                              >
                                <FontAwesomeIcon icon={faTrash} className="text-xs" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </Table>
                  )}
                </Card>
              )}

              {/* Tab 2: Object Mapping */}
              {activeTab === 'mapping' && (
                <Card className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h4 className="font-semibold text-main-text">Collection Object Mapping</h4>
                      <p className="text-xs text-normal-text mt-0.5">
                        Define logical field names mapped to physical dot paths. When writing/reading as `object`,
                        the engine validates types and transparently translates keys.
                      </p>
                    </div>
                    <Btn kind="primary" onClick={handleSaveMapping} loading={mappingSaving}>
                      Save Mapping
                    </Btn>
                  </div>

                  {mappingMsg && (
                    <div
                      className={`p-3 rounded-2xl mb-4 text-xs ${
                        mappingMsg.type === 'success'
                          ? 'bg-emerald-500/10 text-emerald-600'
                          : 'bg-red-500/10 text-red-500'
                      }`}
                    >
                      {mappingMsg.text}
                    </div>
                  )}

                  <textarea
                    rows={12}
                    value={mappingDraft}
                    onChange={(e) => setMappingDraft(e.target.value)}
                    className="w-full font-mono text-xs px-3 py-2 rounded-2xl border border-slate-200 outline-none focus:border-main-blue"
                  />
                </Card>
              )}

              {/* Tab 3: Query Runner */}
              {activeTab === 'query' && (
                <Card className="p-6 space-y-4">
                  <div>
                    <h4 className="font-semibold text-main-text">Query Documents</h4>
                    <p className="text-xs text-normal-text mt-0.5">
                      Filter documents using MongoDB/Postgres style operators (eq, gt, gte, contains, in).
                    </p>
                  </div>

                  <form onSubmit={handleRunQuery} className="space-y-4">
                    <Field label="WHERE Filter (JSON)">
                      <textarea
                        rows={4}
                        value={queryWhere}
                        onChange={(e) => setQueryWhere(e.target.value)}
                        className="w-full font-mono text-xs px-3 py-2 rounded-2xl border border-slate-200 outline-none focus:border-main-blue"
                      />
                    </Field>

                    <div className="grid grid-cols-2 gap-4">
                      <Field label="Order By Field">
                        <Input
                          placeholder="e.g. name or capacity"
                          value={queryOrderBy}
                          onChange={(e) => setQueryOrderBy(e.target.value)}
                        />
                      </Field>
                      <Field label="Direction">
                        <select
                          value={queryOrderDir}
                          onChange={(e) => setQueryOrderDir(e.target.value)}
                          className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm outline-none focus:border-main-blue bg-white"
                        >
                          <option value="asc">Ascending (ASC)</option>
                          <option value="desc">Descending (DESC)</option>
                        </select>
                      </Field>
                    </div>

                    <Btn kind="primary" type="submit" loading={queryRunning}>
                      <FontAwesomeIcon icon={faBolt} className="mr-1.5" /> Execute Query
                    </Btn>
                  </form>

                  {queryResult && (
                    <div className="mt-4 border-t border-slate-100 pt-4">
                      <h5 className="text-xs font-semibold text-main-text mb-2">
                        Query Result ({queryResult.items?.length ?? 0} matches)
                      </h5>
                      <pre className="font-mono text-xs bg-slate-50 p-4 rounded-2xl overflow-x-auto max-h-96">
                        {JSON.stringify(queryResult, null, 2)}
                      </pre>
                    </div>
                  )}
                </Card>
              )}

              {/* Tab 4: Change Feed */}
              {activeTab === 'changes' && (
                <Card className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h4 className="font-semibold text-main-text">Change Feed (Last 24 Hours)</h4>
                      <p className="text-xs text-normal-text mt-0.5">
                        Stream of upserts and mutations to this collection for replication or event pipelines.
                      </p>
                    </div>
                    <Btn kind="secondary" onClick={loadChanges} loading={changesLoading}>
                      <FontAwesomeIcon icon={faRotateRight} className="mr-1.5" /> Refresh Feed
                    </Btn>
                  </div>

                  {changesLoading ? (
                    <TableSkeleton rows={4} />
                  ) : changes.length === 0 ? (
                    <Empty title="No recent changes" sub="Mutations on this collection will stream into this feed." />
                  ) : (
                    <div className="space-y-2">
                      {changes.map((c, i) => (
                        <div key={i} className="p-3 rounded-2xl border border-slate-100 bg-slate-50/50 text-xs">
                          <div className="flex items-center justify-between font-mono font-medium text-main-text">
                            <span>ID: {c.id} (v{c.version})</span>
                            <span className="text-normal-text font-sans">{new Date(c.updatedAt).toLocaleString()}</span>
                          </div>
                          <pre className="mt-2 text-[11px] font-mono text-normal-text overflow-x-auto">
                            {JSON.stringify(c.data || c.object, null, 2)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Modal: Create Collection */}
      {createColOpen && (
        <Modal title="Create SynapseBase Collection" onClose={() => setCreateColOpen(false)}>
          <form onSubmit={handleCreateCollection} className="space-y-4">
            <Field label="Collection Name *">
              <Input
                required
                placeholder="e.g. orders, parks, profiles"
                value={newColName}
                onChange={(e) => setNewColName(e.target.value)}
              />
            </Field>

            <Field label="Description">
              <Input
                placeholder="Optional description"
                value={newColDesc}
                onChange={(e) => setNewColDesc(e.target.value)}
              />
            </Field>

            <Field label="Object Mapping (Optional JSON)">
              <textarea
                rows={6}
                value={newColMapping}
                onChange={(e) => setNewColMapping(e.target.value)}
                className="w-full font-mono text-xs px-3 py-2 rounded-2xl border border-slate-200 outline-none focus:border-main-blue"
              />
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <Btn kind="secondary" onClick={() => setCreateColOpen(false)}>
                Cancel
              </Btn>
              <Btn kind="primary" type="submit" loading={colSubmitting}>
                Create Collection
              </Btn>
            </div>
          </form>
        </Modal>
      )}

      {/* Modal: Create/Edit Document */}
      {docModalOpen && (
        <Modal
          title={editingDocId ? `Edit Document: ${editingDocId}` : 'Create Document'}
          onClose={() => setDocModalOpen(false)}
        >
          <form onSubmit={handleSaveDoc} className="space-y-4">
            {!editingDocId && (
              <Field label="Document ID (Leave empty for auto-generated UUID)">
                <Input
                  placeholder="e.g. park-central"
                  value={editingDocId}
                  onChange={(e) => setEditingDocId(e.target.value)}
                />
              </Field>
            )}

            <Field label="Payload Format">
              <div className="flex gap-4 text-xs font-medium text-main-text">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="docMode"
                    value="object"
                    checked={docMode === 'object'}
                    onChange={() => setDocMode('object')}
                  />
                  <span>Logical Object (Mapped fields)</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="docMode"
                    value="data"
                    checked={docMode === 'data'}
                    onChange={() => setDocMode('data')}
                  />
                  <span>Raw JSON Data</span>
                </label>
              </div>
            </Field>

            <Field label="Document JSON Content">
              <textarea
                rows={10}
                required
                value={docPayload}
                onChange={(e) => setDocPayload(e.target.value)}
                className="w-full font-mono text-xs px-3 py-2 rounded-2xl border border-slate-200 outline-none focus:border-main-blue"
              />
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <Btn kind="secondary" onClick={() => setDocModalOpen(false)}>
                Cancel
              </Btn>
              <Btn kind="primary" type="submit" loading={docSubmitting}>
                Save Document
              </Btn>
            </div>
          </form>
        </Modal>
      )}

      {/* Modal: Atomic Increment Counter */}
      {incrModalOpen && (
        <Modal title={`Atomic Counter: ${incrDocId}`} onClose={() => setIncrModalOpen(false)}>
          <form onSubmit={handleIncrement} className="space-y-4">
            <Field label="Dot Path to Counter Field *">
              <Input
                required
                placeholder="e.g. profile.capacity, stats.views, count"
                value={incrField}
                onChange={(e) => setIncrField(e.target.value)}
              />
            </Field>

            <Field label="Increment By (Negative to decrement)">
              <Input
                type="number"
                required
                value={incrBy}
                onChange={(e) => setIncrBy(e.target.value)}
              />
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <Btn kind="secondary" onClick={() => setIncrModalOpen(false)}>
                Cancel
              </Btn>
              <Btn kind="primary" type="submit" loading={incrSubmitting}>
                Increment Counter
              </Btn>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
