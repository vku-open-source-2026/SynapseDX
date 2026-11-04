# DX-OS 2026 tier model and feature specialization

Date: 2026-11-04. Source material:

- VFOSSA, *Thể lệ OLP Phần mềm nguồn mở năm 2026*:
  <https://vfossa.vn/tin-tuc/the-le-olp-phan-mem-nguon-mo-nam-2026-760.html>
- VFOSSA, *Giới thiệu mô hình DX-OS và chủ đề cuộc thi*:
  <https://vfossa.vn/tin-tuc/gioi-thieu-mo-hinh-dx-os-va-chu-de-cuoc-thi-phan-mem-nguon-mo-olp-2026-761.html>
- VFOSSA, *Đề thi PMNM OLP 2026 — DX-OS Open-Core*:
  <https://vfossa.vn/tin-tuc/de-thi-phan-mem-nguon-mo-olp-2026-798.html>
- DX-OS book: <https://opendigitransform.gitbook.io/dx-os>

## 1. What the exam actually asks for

The 2026 open-source software exam asks teams to build a **DX-OS Open-Core**
model: a headless Tier-1 platform plus at least one H-P-D-I application in
Tier 2. The scoring is 50 points on project health (PoF) and 50 points on the
product/demo:

- public source repository with a web viewer and real history;
- OSI-approved license in every source file, full license text, compatible
  dependencies;
- at least one versioned release, open archive formats only;
- build/install from source with documented configuration;
- declared dependencies (no vendored modifications, no surprises);
- README, CHANGELOG, bug tracker, usable documentation;
- originality, completeness, usability, sustainability and demo quality.

This means **a working product plus open-source evidence**, not a slide deck.
Every tier must ship source, tests, docs, a release and a reproducible build.

## 2. The three DX-OS tiers

The exam defines a three-tier separation of concerns:

| Tier | Name | Owns | Must not own |
| --- | --- | --- | --- |
| 1 | Core digital service platform (PaaS, headless) | identity/SSO/MFA, API gateway, structured/unstructured data, workflow, queue/stream, storage, notifications, audit, tenancy, AI inference primitives | product UI, domain business rules, city/SOS-specific models |
| 2 | Digital capability layer (H-P-D-I) | reusable human/process/data/intelligence capabilities, management plane, shared templates, HITL, reports, knowledge, agent operations | a specific city's assets, incidents, budgets, dispatch or EOP policy |
| 3 | Digital business platform | domain apps: City infrastructure operations, SOS emergency operations, and future verticals | reimplementing Tier-1 primitives or bypassing Tier-2 |

The dependency direction is strict:

```text
Tier 3 (City / SOS) -> Tier 2 (SynapseDX API/SDK) -> Tier 1 (@synapseone/sdk)
```

No Tier-3 product imports `@synapseone/sdk`, calls a Tier-1 service, shares a
Tier-1 database, or calls the other Tier-3 product.

## 3. H-P-D-I is a capability map, not four dashboards

The book describes a maturity path where control moves from people to
algorithms. The four spaces are cumulative:

| Space | Question it answers | Tier-2 capability examples |
| --- | --- | --- |
| **H — Human** | Can people work in one digital environment? | workspace, personal drive, knowledge wiki, directory, activity feed, collaboration, notifications, mobile field app |
| **P — Process** | Is the work standardized and enforced? | forms, BPMN/process definitions, approvals/HITL, SLA, e-office, people/KPI, projects/timesheets, policy checks |
| **D — Data** | Can managers decide from a single source of truth? | dataset contracts, NGSI-LD projection, schema registry, quality checks, lineage, reports/BI, IOC dashboards, data products |
| **I — Intelligence** | Can the system act with bounded autonomy? | RAG assistant, document OCR/extraction, recommendations, anomaly detection, agent registry, tool permissions, human approval gates |

A product that only has H is a portal. A product with H+P is workflow
automation. H+P+D is management by evidence. H+P+D+I is an AI-native operating
system — and only if the first three are stable. The exam explicitly warns that
AI on top of dirty data produces "data hallucinations".

## 4. Tier-2: ERP-grade capability substrate, not a monolith

The useful reading of "Tier 2 is like ERP" is **ERP-grade shared capabilities**,
not a single ERP product:

- ERP gives every department one identity, one process engine, one data model,
  one approval trail and one reporting layer.
- DX-OS Tier 2 should give every domain product the same H-P-D-I capabilities
  through one contract, so City, SOS and future verticals do not rebuild them.
- Vertical ERP suites (OMS/WMS/POS/TMS, MES/SCADA, EMR, LMS, CRM, BMS) remain
  **Tier-3 business applications** or optional Tier-3 packs. Putting them in
  Tier 2 would make the platform city-specific and violate the reusable-
  capability rule.

Tier-2 should therefore expose **bounded, composable modules**:

```text
Identity/workspace (H)  -> who works, where they work, what they know
Process/approval (P)    -> what must happen, who approves, what the SLA is
Data/reporting (D)      -> what is true, what changed, what it means
Intelligence (I)        -> what the system recommends, with a human gate
Management plane        -> who can operate which module, with audit
```

Each module must be usable by at least two domain products. A feature that only
City needs belongs in City. A feature that only SOS needs belongs in SOS.

## 5. Feature allocation matrix

| Capability | Tier 1 | Tier 2 | Tier 3 |
| --- | --- | --- | --- |
| SSO, MFA, sessions, API keys, delegated tokens | owns | proxies/adapts | consumes session |
| Users, roles, policies, SCIM | owns | admin projection + role UX | product role mapping only |
| API gateway, rate limits, CORS, zero-trust edge | owns | public capability gateway | public product edge |
| Structured documents/records, queries, versions | owns | dataset/record capability | domain records |
| Object storage, checksums, quotas | owns | file capability | domain attachments |
| Queue/stream/events, outbox | owns | capability event feed | domain consumers |
| Workflow engine, durable waits | owns | BPMN/forms/HITL templates | domain process rules |
| Notifications, templates, preferences | owns | channel orchestration | recipient policy |
| AI inference, embeddings, routing | owns | RAG, OCR, agents, guardrails | domain prompts/agents |
| Audit, usage, lineage | owns primitives | management audit/reporting | domain audit views |
| Workspace/wiki/collaboration | — | owns | uses |
| Forms, approvals, SLA, e-office | workflow primitive | owns | configures |
| Projects, portfolios, timesheets | — | owns generic model | uses |
| HR directory, KPIs (generic) | identity primitive | owns generic people capability | configures |
| Reports/BI/IOC dashboards | data primitives | owns | domain dashboards |
| Data quality, schema registry, lineage | storage primitives | owns | declares contracts |
| OMS/WMS/POS/TMS, MES/SCADA, EMR, LMS, CRM, BMS | — | — | owns |
| City assets, incidents, budgets, maintenance | — | — | City owns |
| SOS hazards, dispatch, shelters, EOP, AAR | — | — | SOS owns |

## 6. Human-in-the-loop (HITL) contract

HITL is the safety valve that lets Tier 2 move from P to I without losing
accountability. A generic Tier-2 approval should have:

- **request**: module, entity, action, payload snapshot, requester, tenant;
- **policy**: required roles, quorum, separation of duties, SLA, escalation;
- **steps**: ordered or parallel approvers, delegation, abstain, reject;
- **decision**: approve/reject/request-changes, note, attachments, timestamp;
- **effects**: on approve call a Tier-1 workflow signal or a registered effect;
- **audit**: immutable event per transition, correlation id, actor, reason;
- **notification**: inbox + email/SMS/push through Tier-1 notifications;
- **UI**: my approvals, team queue, overdue, history, bulk actions;
- **AI gate**: an agent may draft or recommend, but a human must approve any
  action above the tenant's risk threshold.

State machine:

```text
draft -> submitted -> pending -> approved -> applied
                         |  \-> rejected
                         |  \-> changes_requested -> submitted
                         \-> expired / escalated
```

The same contract should serve City budget approvals, incident cost approval,
SOS dispatch approval, EOP publication, dataset review and future modules.

## 7. Management roles and separation of duties

Tier 2 derives roles from the verified Tier-1 principal, never from a request
body:

| Role | Typical scope | Can do | Cannot do |
| --- | --- | --- | --- |
| Administrator | `*` / `synapsedx:admin` | all modules, tenant settings, role visibility | bypass audit |
| Operator | `write` / `synapsedx:operator` | datasets, records, publish/revoke, outbox, files, notifications | approve own review, change roles |
| Moderator | `synapsedx:moderator` | review queue, approve/reject, audit read | publish/delete, manage users |
| Manager | `*:read` / `synapsedx:manager` | dashboards, audit, usage, reports | mutate data |
| Viewer | public or tenant read | public catalog | any mutation |

The console hides actions by permission, but every route enforces the same
decision server-side. Clinicians/responders/operators in Tier 3 may map to
different product roles; that mapping stays in Tier 3.

## 8. Management console scope

The Tier-2 console at `cloud.synapsedx.sbs` should cover:

1. **Overview**: dataset counts, publications, review queue, outbox, tier health.
2. **Datasets**: create/edit, license/schema, public flag, publish/revoke,
   review submission, delete with purge.
3. **Records**: browse, create/edit/delete, bulk import, publication flag.
4. **Moderation**: pending/approved/rejected queue, approve/reject with note.
5. **Events**: feed, cursor, outbox recovery.
6. **Audit & usage**: mutation audit, usage summary, filters.
7. **Settings**: verified principal, scopes, roles, session revocation.
8. **Future**: team/role administration, module settings, report builder,
   approval inbox, knowledge workspace, agent operations.

## 9. OLP 2026 evidence checklist

Before submission (deadline 2026-12-06 17:00, demo 2026-12-10):

- [ ] Every source file has `SPDX-License-Identifier: Apache-2.0` (or the
      declared license) and the repository has `LICENSE` + `NOTICE`.
- [ ] Public GitHub repository with working web viewer and real commit history.
- [ ] At least one versioned release per product; assets use `.tar.gz`/`.whl`/
      npm `.tgz`, never `.zip`/`.rar`.
- [ ] `README`, `CHANGELOG`, `docs/`, bug tracker, build-from-source guide.
- [ ] Reproducible `docker compose` demo with seed data.
- [ ] SBOM and dependency license report attached to the release.
- [ ] Screenshots and a 15-minute demo script covering architecture, features,
      DX-Lab scenario, H-P-D-I and HITL.
- [ ] No secrets, private endpoints or operator credentials in the repository.
- [ ] Tier boundary verified: City/SOS never import Tier-1; no cross-product API.

## 10. Issue map

The backlog is split by tier so each repository owns its specialization.

### Tier 1 — SynapseOne

| Issue | Capability |
| --- | --- |
| [#44](https://github.com/vku-open-source-2026/SynapseOne/issues/44) | Durable human task / wait-for-signal |
| [#45](https://github.com/vku-open-source-2026/SynapseOne/issues/45) | Signed audit export and retention |
| [#46](https://github.com/vku-open-source-2026/SynapseOne/issues/46) | Full-text + semantic search |
| [#47](https://github.com/vku-open-source-2026/SynapseOne/issues/47) | Tenant-scoped secret vault |
| [#48](https://github.com/vku-open-source-2026/SynapseOne/issues/48) | SCIM 2.0 provisioning |
| [#49](https://github.com/vku-open-source-2026/SynapseOne/issues/49) | Image signing + SBOM/provenance |

### Tier 2 — SynapseDX

| Issue | Capability |
| --- | --- |
| [#31](https://github.com/vku-open-source-2026/SynapseDX/issues/31) | ERP-grade Tier-2 boundary decision |
| [#32](https://github.com/vku-open-source-2026/SynapseDX/issues/32) | Collaboration inbox and preferences |
| [#33](https://github.com/vku-open-source-2026/SynapseDX/issues/33) | Team and role administration |
| [#34](https://github.com/vku-open-source-2026/SynapseDX/issues/34) | Generic HITL approvals |
| [#35](https://github.com/vku-open-source-2026/SynapseDX/issues/35) | Workspace, wiki and PARA |
| [#36](https://github.com/vku-open-source-2026/SynapseDX/issues/36) | People directory, KPIs and timesheets |
| [#37](https://github.com/vku-open-source-2026/SynapseDX/issues/37) | Form builder and BPMN |
| [#38](https://github.com/vku-open-source-2026/SynapseDX/issues/38) | Projects and portfolio |
| [#39](https://github.com/vku-open-source-2026/SynapseDX/issues/39) | Reports, IOC dashboards and exports |
| [#40](https://github.com/vku-open-source-2026/SynapseDX/issues/40) | Dataset contracts, quality and lineage |
| [#41](https://github.com/vku-open-source-2026/SynapseDX/issues/41) | Console Playwright/accessibility suite |
| [#42](https://github.com/vku-open-source-2026/SynapseDX/issues/42) | Enforced review policy and bulk moderation |
| [#43](https://github.com/vku-open-source-2026/SynapseDX/issues/43) | OCR and human correction queue |
| [#44](https://github.com/vku-open-source-2026/SynapseDX/issues/44) | Agent registry and run traces |
| [#45](https://github.com/vku-open-source-2026/SynapseDX/issues/45) | RAG assistant with citations |

### Tier 3 — SynapseCity

| Issue | Capability |
| --- | --- |
| [#28](https://github.com/vku-open-source-2026/SynapseCity/issues/28) | OLP 2026 City demo pack |
| [#29](https://github.com/vku-open-source-2026/SynapseCity/issues/29) | Asset criticality and predictive maintenance |
| [#30](https://github.com/vku-open-source-2026/SynapseCity/issues/30) | Adopt Tier-2 HITL for approvals |

### Tier 3 — SynapseCitySOS

| Issue | Capability |
| --- | --- |
| [#23](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/23) | Mutual-aid resource requests |
| [#24](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/24) | HITL dispatch/EOP/escalation |
| [#25](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/25) | OLP 2026 SOS demo pack |

See each issue for detailed acceptance criteria.
