/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// SynapseLDS console — licensed NGSI-LD datasources. Users create a
// datasource (open-data license required), register a dynamic attribute
// schema with per-field visibility, ingest records, and preview the
// structural-allowlist NGSI-LD export. `_core` metadata never leaves the
// service; unregistered fields default to visibility=internal.
import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api, baseUrl } from '../lib/api.js';
import { Badge, Btn, Card, Code, Empty, Err, Field, Input, Modal, PageTitle, Table, TableSkeleton } from '../components/ui.jsx';
import { ListSkeleton } from '../components/loading.jsx';

const selCls = 'w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm text-main-text outline-none focus:border-main-blue bg-white';
const CUSTOM_LICENSE = '__custom__';
const VIS_TONE = { public: 'green', restricted: 'amber', internal: 'gray' };

const EMPTY_ATTR = () => ({ name: '', ngsiLdType: 'Property', visibility: 'internal', description: '' });

export default function LinkedData() {
  const { headers } = useAuth();
  const [rows, setRows] = useState([]);
  const [licenses, setLicenses] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selId, setSelId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [attrDraft, setAttrDraft] = useState([]);
  const [attrBusy, setAttrBusy] = useState(false);
  const [attrMsg, setAttrMsg] = useState(null);
  const [ingestText, setIngestText] = useState('');
  const [ingestBusy, setIngestBusy] = useState(false);
  const [ingestResult, setIngestResult] = useState(null);
  const [entities, setEntities] = useState(null);
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [licenseBusy, setLicenseBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({
    name: '', slug: '', entityType: 'Organization', license: 'CC-BY-4.0',
    customLicense: '', licenseUrl: '', contexts: '', defaultVisibility: 'internal', description: '',
  });
  const loadSeq = useRef(0);

  const load = async () => {
    const my = ++loadSeq.current;
    setErr(null);
    try {
      const [ds, lic] = await Promise.all([api.ldsDatasources(headers), api.ldsLicenses(headers)]);
      if (loadSeq.current === my) {
        setRows(Array.isArray(ds) ? ds : []);
        setLicenses(Array.isArray(lic) ? lic : []);
      }
    } catch (e) {
      if (loadSeq.current === my) setErr(e);
    } finally {
      if (loadSeq.current === my) setLoaded(true);
    }
  };

  useEffect(() => {
    load();
  }, [headers]);

  const loadDetail = async (id, { keepAttrMsg = false } = {}) => {
    setDetailLoading(true);
    // The stale-saved banner is only cleared on REAL selection changes; reflexive
    // refreshes after a save (e.g. saveAttributes) must not wipe confirmations.
    if (!keepAttrMsg) setAttrMsg(null);
    try {
      const d = await api.ldsDatasource(id, headers);
      setDetail(d);
      setAttrDraft((d.attributes || []).map((a) => ({ ...a, description: a.description || '' })));
    } catch (e) {
      setErr(e);
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const select = (id) => {
    setSelId(id);
    setDetail(null);
    setEntities(null);
    setIngestResult(null);
    setIngestText('');
    if (id) loadDetail(id);
  };

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    // Pre-validate against the server contract so the wizard fails loudly and
    // locally (with actionable text) instead of an opaque 400 after submit.
    const problems = [];
    const name = form.name.trim();
    if (!name) problems.push('Name is required');
    else if (name.length > 200) problems.push('Name must be ≤200 chars');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(form.entityType.trim())) problems.push('Entity type must match [A-Za-z][A-Za-z0-9_-]{0,63} (e.g. Organization)');
    const slug = form.slug.trim();
    if (slug && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) problems.push('Slug must be lowercase letters/numbers/dashes (a-z0-9-)');
    const isCustom = form.license === CUSTOM_LICENSE;
    if (isCustom) {
      if (!/^LicenseRef-/.test(form.customLicense.trim()) || form.customLicense.trim().length > 80) problems.push('Custom license id must be LicenseRef-<name>');
      if (!/^https?:\/\/\S+$/.test(form.licenseUrl.trim())) problems.push('Custom licenses need an http(s) license URL');
    }
    const contextList = form.contexts.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    for (const c of contextList) if (!/^https?:\/\/\S{1,400}$/.test(c)) { problems.push(`Context must be an http(s) URL: ${c.slice(0, 80)}`); break; }
    if (contextList.length > 10) problems.push('Max 10 context URLs');
    if (problems.length) {
      setErr(new Error(problems.join(' · ')));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body = {
        name,
        entityType: form.entityType.trim(),
        license: isCustom ? form.customLicense.trim() : form.license,
        defaultVisibility: form.defaultVisibility,
      };
      if (slug) body.slug = slug;
      if (isCustom) body.licenseUrl = form.licenseUrl.trim();
      if (contextList.length) body.contexts = contextList;
      if (form.description.trim()) body.description = form.description.trim();
      const ds = await api.ldsCreateDatasource(body, headers);
      setOpen(false);
      setForm({ name: '', slug: '', entityType: 'Organization', license: 'CC-BY-4.0', customLicense: '', licenseUrl: '', contexts: '', defaultVisibility: 'internal', description: '' });
      await load();
      select(ds.id);
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const saveAttributes = async () => {
    if (!detail || attrBusy) return;
    setAttrBusy(true);
    setAttrMsg(null);
    setErr(null);
    try {
      const attributes = attrDraft
        .filter((a) => a.name.trim())
        .map((a) => {
          const out = { name: a.name.trim(), ngsiLdType: a.ngsiLdType, visibility: a.visibility };
          if (a.description && a.description.trim()) out.description = a.description.trim();
          if (a.sourceField && a.sourceField.trim()) out.sourceField = a.sourceField.trim();
          return out;
        });
      const saved = await api.ldsSetAttributes(detail.id, attributes, headers);
      setAttrDraft((saved || []).map((a) => ({ ...a, description: a.description || '' })));
      setAttrMsg({ ok: true, text: `Saved ${attributes.length} attribute definition(s)` });
      loadDetail(detail.id, { keepAttrMsg: true });
    } catch (ex) {
      setErr(ex);
      if (ex?.body?.reserved) setAttrMsg({ ok: false, text: `Reserved names rejected: ${ex.body.reserved.join(', ')} — map them via sourceField instead` });
    } finally {
      setAttrBusy(false);
    }
  };

  const ingest = async () => {
    if (!detail || ingestBusy) return;
    let payload;
    try {
      const parsed = JSON.parse(ingestText);
      payload = Array.isArray(parsed) ? { records: parsed } : parsed;
    } catch {
      setErr(new Error('Ingest payload must be valid JSON (a record object or an array of records)'));
      return;
    }
    setIngestBusy(true);
    setErr(null);
    setIngestResult(null);
    try {
      const r = await api.ldsIngest(detail.id, payload, headers);
      setIngestResult(r);
      loadDetail(detail.id);
      loadEntities(detail.id);
    } catch (ex) {
      setErr(ex);
    } finally {
      setIngestBusy(false);
    }
  };

  const loadEntities = async (id) => {
    if (!id) return;
    setEntitiesLoading(true);
    try {
      const list = await api.ldsEntities(id, { limit: 20 }, headers);
      setEntities(Array.isArray(list) ? list : []);
    } catch (ex) {
      setErr(ex);
      setEntities([]);
    } finally {
      setEntitiesLoading(false);
    }
  };

  const remove = async (id) => {
    if (deletingId) return;
    if (!window.confirm('Delete this datasource? Its attribute registry and records are removed too.')) return;
    setDeletingId(id);
    try {
      await api.ldsDeleteDatasource(id, headers);
      if (selId === id) select(null);
      await load();
    } catch (ex) {
      setErr(ex);
    } finally {
      setDeletingId(null);
    }
  };

  const changeLicense = async (licenseId) => {
    if (!detail || licenseBusy) return;
    setLicenseBusy(true);
    setErr(null);
    try {
      const d = await api.ldsUpdateDatasource(detail.id, { license: licenseId }, headers);
      setDetail({ ...detail, license: d.license, licenseUrl: d.licenseUrl });
      load();
    } catch (ex) {
      setErr(ex);
    } finally {
      setLicenseBusy(false);
    }
  };

  const exportUrl = detail ? `${baseUrl()}/v1/lds/datasources/${detail.id}/entities` : '';
  const copyExport = () => {
    try {
      navigator.clipboard.writeText(exportUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const patchAttr = (i, patch) => setAttrDraft((d) => d.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  return (
    <>
      <PageTitle
        title="Linked Data"
        sub="SynapseLDS — publish licensed NGSI-LD datasets; dynamic fields only leave the API once the schema marks them public"
        right={<Btn onClick={() => setOpen(true)}>+ New datasource</Btn>}
      />
      <Err e={err} />

      <Card>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm text-normal-text">
            Each datasource stores records as <code className="font-mono text-xs">_core + entity + attributes</code>.
            Platform metadata (<code className="font-mono text-xs">_core</code>) is never serialized; unregistered fields stay <Badge tone="gray">internal</Badge>.
          </p>
        </div>
        {!loaded ? (
          <TableSkeleton rows={3} cols={5} />
        ) : rows.length ? (
          <Table head={['Name', 'Entity type', 'License', 'Records', '']}>
            {rows.map((d) => (
              <tr key={d.id} className={`border-t border-slate-100 ${selId === d.id ? 'bg-slate-50/70' : ''}`}>
                <td className="py-2 pr-4">
                  <button onClick={() => select(d.id)} className="font-medium text-main-text text-left hover:text-main-blue">
                    {d.name}
                  </button>
                  <div className="text-[11px] text-normal-text font-mono">{d.slug}</div>
                </td>
                <td className="py-2 pr-4 text-xs text-normal-text font-mono">{d.entityType}</td>
                <td className="py-2 pr-4">
                  <Badge tone={d.license === 'LicenseRef-Proprietary' ? 'gray' : 'blue'}>{d.license}</Badge>
                </td>
                <td className="py-2 pr-4 text-xs text-normal-text">{selId === d.id && detail?.stats ? detail.stats.records : '—'}</td>
                <td className="py-2 text-right whitespace-nowrap">
                  <button onClick={() => select(d.id)} className="text-xs text-main-blue mr-3">Open</button>
                  <button onClick={() => remove(d.id)} disabled={deletingId === d.id} className="text-xs text-red-500 disabled:opacity-50 inline-flex items-center gap-1.5">
                    {deletingId === d.id && <span className="sdx-spinner h-3.5 w-3.5 border-2" />}
                    {deletingId === d.id ? 'Deleting…' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty
            text="No datasources yet — create one to publish your first NGSI-LD dataset"
            action={<Btn onClick={() => setOpen(true)}>+ New datasource</Btn>}
          />
        )}
      </Card>

      {selId && (
        detailLoading || !detail ? (
          <Card><ListSkeleton rows={3} /></Card>
        ) : (
          <>
            <Card>
              <div className="flex flex-wrap items-center gap-2 justify-between mb-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-base font-semibold text-main-text">{detail.name}</h2>
                  <Badge tone="blue">{detail.entityType}</Badge>
                  <a href={detail.licenseUrl} target="_blank" rel="noreferrer">
                    <Badge tone={detail.license === 'LicenseRef-Proprietary' ? 'gray' : 'green'}>{detail.license}</Badge>
                  </a>
                </div>
                <div className="flex items-center gap-2">
                  <select value={detail.license} onChange={(e) => changeLicense(e.target.value)} disabled={licenseBusy} className={`${selCls} w-auto`} title="Change license">
                    {licenses.map((l) => <option key={l.id} value={l.id}>{l.id}</option>)}
                    {!licenses.some((l) => l.id === detail.license) && <option value={detail.license}>{detail.license}</option>}
                  </select>
                  {licenseBusy && <span className="sdx-spinner h-4 w-4 border-2" />}
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-2 text-xs text-normal-text">
                <p>Records: <b className="text-main-text">{detail.stats?.records ?? 0}</b></p>
                <p>
                  Attributes:{' '}
                  <Badge tone="green">{detail.stats?.attributes?.public ?? 0} public</Badge>{' '}
                  <Badge tone="amber">{detail.stats?.attributes?.restricted ?? 0} restricted</Badge>{' '}
                  <Badge tone="gray">{detail.stats?.attributes?.internal ?? 0} internal</Badge>
                </p>
                <p className="sm:col-span-2">Contexts: <span className="font-mono">{detail.contexts?.length ? detail.contexts.join(', ') : 'core context only'}</span></p>
                <p className="sm:col-span-2 truncate">
                  NGSI-LD export (public — no sign-in needed):{' '}
                  <a href={exportUrl} target="_blank" rel="noreferrer" className="font-mono text-main-blue hover:underline">{exportUrl}</a>{' '}
                  <button onClick={copyExport} className="text-xs text-main-blue ml-1">{copied ? 'copied!' : 'copy'}</button>
                </p>
              </div>
            </Card>

            <Card>
              <h3 className="text-sm font-semibold text-main-text mb-1">Attribute schema (registry)</h3>
              <p className="text-xs text-normal-text mb-3">
                Default deny: fields not listed here are stored but never exported. Reserved names (id, type, @context, internalId, tenantId, …) are rejected.
              </p>
              <Table head={['Attribute', 'NGSI-LD type', 'Visibility', 'Source field', 'Description', '']}>
                {attrDraft.map((a, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="py-2 pr-3"><Input value={a.name} onChange={(e) => patchAttr(i, { name: e.target.value })} placeholder="name" className={`${selCls} font-mono`} /></td>
                    <td className="py-2 pr-3">
                      <select value={a.ngsiLdType} onChange={(e) => patchAttr(i, { ngsiLdType: e.target.value })} className={selCls}>
                        <option>Property</option><option>Relationship</option><option>GeoProperty</option>
                      </select>
                    </td>
                    <td className="py-2 pr-3">
                      <select value={a.visibility} onChange={(e) => patchAttr(i, { visibility: e.target.value })} className={selCls}>
                        <option value="public">public</option><option value="restricted">restricted</option><option value="internal">internal</option>
                      </select>
                    </td>
                    <td className="py-2 pr-3"><Input value={a.sourceField || ''} onChange={(e) => patchAttr(i, { sourceField: e.target.value })} placeholder="raw key (optional)" className={`${selCls} font-mono`} /></td>
                    <td className="py-2 pr-3"><Input value={a.description} onChange={(e) => patchAttr(i, { description: e.target.value })} placeholder="optional" /></td>
                    <td className="py-2 text-right">
                      <button onClick={() => setAttrDraft((d) => d.filter((_, j) => j !== i))} className="text-xs text-red-500">Remove</button>
                    </td>
                  </tr>
                ))}
              </Table>
              <div className="mt-3 flex items-center gap-3 flex-wrap">
                <Btn kind="ghost" onClick={() => setAttrDraft((d) => [...d, EMPTY_ATTR()])}>+ Add attribute</Btn>
                <Btn onClick={saveAttributes} loading={attrBusy}>Save schema</Btn>
                {attrMsg && <span className={`text-xs ${attrMsg.ok ? 'text-emerald-600' : 'text-amber-600'}`}>{attrMsg.text}</span>}
              </div>
            </Card>

            <Card>
              <h3 className="text-sm font-semibold text-main-text mb-1">Ingest records</h3>
              <p className="text-xs text-normal-text mb-3">
                Paste one record or an array. <code className="font-mono">id</code> becomes the source id (kept in <code className="font-mono">_core</code>);
                the public NGSI-LD entity id is <code className="font-mono">urn:ngsi-ld:{detail.entityType}:&lt;id&gt;</code> unless you pass <code className="font-mono">ngsiLdId</code> as an IRI.
              </p>
              <textarea
                value={ingestText}
                onChange={(e) => setIngestText(e.target.value)}
                rows={5}
                placeholder={`{ "id": "55001", "name": "Công ty ABC", "locatedIn": "urn:ngsi-ld:AdministrativeArea:danang" }`}
                className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono text-main-text outline-none focus:border-main-blue"
              />
              <div className="mt-3 flex items-center gap-3 flex-wrap">
                <Btn onClick={ingest} loading={ingestBusy} disabled={!ingestText.trim()}>Ingest</Btn>
                {ingestResult && (
                  <span className="text-xs text-normal-text">
                    ingested <b className="text-main-text">{ingestResult.ingested}</b>
                    {' '}(created {ingestResult.created}, updated {ingestResult.updated})
                    {ingestResult.quarantined?.length > 0 && (
                      <Badge tone="amber">quarantined {ingestResult.quarantined.length}</Badge>
                    )}
                  </span>
                )}
              </div>
              {ingestResult?.quarantined?.length > 0 && (
                <ul className="mt-2 text-[11px] text-amber-600 list-disc pl-5">
                  {ingestResult.quarantined.slice(0, 6).map((q, i) => (
                    <li key={i}><code className="font-mono">{q.field}</code>: {q.reason}</li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-main-text">NGSI-LD preview (public attributes only)</h3>
                <Btn kind="ghost" onClick={() => loadEntities(detail.id)} loading={entitiesLoading}>Load export</Btn>
              </div>
              {entities === null ? (
                <p className="text-xs text-normal-text">Nothing loaded yet — the same projection the public export URL serves will show here.</p>
              ) : entities.length === 0 ? (
                <Empty text="No entities yet (or nothing is public — check the schema visibility)" />
              ) : (
                <Code data={entities} limit={4000} />
              )}
            </Card>
          </>
        )
      )}

      {open && (
        <Modal title="New datasource" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Business Registry" required />
            </Field>
            <Field label="Slug (optional — derived from the name)">
              <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="business-registry" className={`${selCls} font-mono`} />
            </Field>
            <Field label="Entity type">
              <Input value={form.entityType} onChange={(e) => setForm({ ...form, entityType: e.target.value })} placeholder="Organization" required />
            </Field>
            <Field label="Open-data license (shown on every export via Link rel=license)">
              <select value={form.license} onChange={(e) => setForm({ ...form, license: e.target.value })} className={selCls}>
                {licenses.map((l) => (
                  <option key={l.id} value={l.id}>{l.id}{l.openData ? '' : ' — not open data'}</option>
                ))}
                <option value={CUSTOM_LICENSE}>Custom (LicenseRef-…)</option>
              </select>
            </Field>
            {form.license === CUSTOM_LICENSE && (
              <>
                <Field label="Custom license id (LicenseRef-*)">
                  <Input value={form.customLicense} onChange={(e) => setForm({ ...form, customLicense: e.target.value })} placeholder="LicenseRef-Government-Open-Optional" className={`${selCls} font-mono`} required />
                </Field>
                <Field label="License URL">
                  <Input value={form.licenseUrl} onChange={(e) => setForm({ ...form, licenseUrl: e.target.value })} placeholder="https://data.example.vn/license" required />
                </Field>
              </>
            )}
            <Field label="JSON-LD context URLs (comma or newline separated, optional)">
              <Input value={form.contexts} onChange={(e) => setForm({ ...form, contexts: e.target.value })} placeholder="https://data.example.vn/context/organization.jsonld" className={`${selCls} font-mono`} />
            </Field>
            <Field label="Default visibility for new attributes">
              <select value={form.defaultVisibility} onChange={(e) => setForm({ ...form, defaultVisibility: e.target.value })} className={selCls}>
                <option value="internal">internal (safe default)</option>
                <option value="public">public</option>
              </select>
            </Field>
            <Field label="Description (optional)">
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Danang business registry — open data" />
            </Field>
            <Btn type="submit" loading={busy} disabled={!form.name.trim() || (form.license === CUSTOM_LICENSE && (!form.customLicense.trim() || !form.licenseUrl.trim()))}>Create datasource</Btn>
          </form>
        </Modal>
      )}

      <p className="mt-3 text-xs text-normal-text">
        <Badge>Tip</Badge> Pipeline: connector → <code className="font-mono">POST …/records</code> → schema registry filters → NGSI-LD projector → <code className="font-mono">GET …/entities</code>.
        Wire it into automations with a Workflow <code className="font-mono">synapsedx.api → lds.publish-record</code> node (template <code className="font-mono">webhook-to-lds</code>).
      </p>
    </>
  );
}
