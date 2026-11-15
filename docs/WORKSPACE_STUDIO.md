# Workspace Studio and Common workspace

City and SOS operational interfaces run as installed product plugins in DX at
`/workspace`. Each app has its own **Common workspace** plugin:

| App | Plugin | Runtime |
| --- | --- | --- |
| SynapseCity | `city-common-workspace` (City repository) | `/workspace?product=city&page=city-common-workspace` |
| SynapseCity SOS | `sos-common-workspace` (SOS repository) | `/workspace?product=sos&page=sos-common-workspace` |

Common describes reused capabilities, not common members or common data. App
membership is explicit (`productRoles.city` / `productRoles.sos`). Legacy global
roles grant no app access. A City app admin is not an IAM organization admin.
Only a verified IAM organization administrator may navigate to `/admin` or
manage Studio, plugins, installations and app grants.

Common API calls carry `X-Workspace-App: city|sos`. DX verifies persisted app
membership and scopes capability documents to `<organization>:common:<app>`.
Projects, tasks, wiki pages, inbox, forms/processes, files, OCR, reports and RAG
records remain separate, including when one person belongs to both apps.
Original organization capability records remain in the H-D-P-I administration
catalog; they are not silently copied to both apps. The obsolete global
`dx-team-workspace` starter is retired.

## Compose H-D-P-I capabilities into an app

1. Open **H-D-P-I catalog** at `/admin/modules` as an organization admin.
2. Select the target app, open a capability and choose **Use in page builder**.
3. Create the draft. Studio creates editable widgets, forms and section navigation for Tasks, Projects, Wiki, Inbox, Forms, Reports, OCR and Assistant. Other catalog tools require declarative components or an explicitly authored code widget; opaque capability embeds cannot be published.
4. Arrange components, save, publish and install for the intended app roles.
5. Open the app's Common workspace. Module links retain the app context.

Templates migrate presentation/configuration. They do not change existing data
ownership. Organization records require an explicit destination-aware migration;
import/export of a plugin never includes business records, memberships or secrets.

## Designer and runtime

Studio includes a component library, responsive drag/drop canvas, layer list,
properties, keyboard reorder, duplicate/remove, width controls and undo/redo.
Components: heading, text, alert, divider, navigation, tabs, button, metric, table,
chart, list, progress, form, capability, map, Kanban, timeline, safe Markdown and custom code.
Layouts use a responsive 12-column grid with full, half, third and quarter widths,
JSON widget order and optional section ids. Canvas section filtering keeps large
pages manageable. Standard widgets are declarative. A custom code widget stores
bounded HTML/CSS/JavaScript source and explicit same-page data/action references;
DX never evaluates that source on its server.

Runtime provides app navigation, operational metrics, searchable/paginated
record tables, current-page CSV export, record details and contextual action
forms. Delete actions require confirmation. Workflow acceptance is displayed as
pending processing; the UI does not claim asynchronous mutations have completed.

Map widgets use Leaflet with the configured DX VietMap tiles and real WGS84
coordinates/GeoJSON. Invalid/missing locations do not become 0,0. Controls include
fit, zoom, overlays and fullscreen. Maps paginate records and disclose the loaded
range. Tile failures remain visible. Credentials use headers, never tile URLs.

Published snapshots are immutable. Draft changes reach members after publication.
Product datasets/actions remain bound to that app's allowlist and protected
same-organization workflow artifacts. Reviewed workflow source can be edited in
DX Workflow Studio and synchronized with its owning product repository.

## Current LCDP boundary

The two app-owned Common plugins contain 39 declarative widgets in eight sections
(Tasks, Projects, Wiki, Inbox, Forms/Approvals, Reports, OCR and Assistant). They
contain no `capability` embeds. Widget composition, section navigation, collection
columns, forms, options/defaults and capability bindings are editable in Studio
and survive portable export/import. Runtime follows JSON order and widths.

The platform shell, sidebar, renderer primitives, modal mechanics and business
capability implementations remain React/TypeScript code. Legacy `capability` widgets embed prebuilt modules whose internals are not editable; publication now rejects those widgets. This release does not establish full advanced domain parity
with every archived City/SOS screen; see `WORKSPACE_BUSINESS_AUDIT.md`.

## Capability bindings and forms

The City/SOS resource catalog exposes 21 fixed `common*` connectors, including
projects/tasks, knowledge, notifications, forms/processes, approvals, reports,
files/OCR, people/KPIs/timesheets and agents/RAG. They forward only the caller's
credential and the verified installed app to DX's public capabilities API. A
plugin cannot select a URL, supply a service token or bypass the capability's
existing authorization. Product resources continue using protected pinned
workflow artifacts; they cannot use the Common action path.

Forms support text, number, textarea, select, date, datetime-local, checkbox,
email, JSON and Markdown. Selects can bind to an allowlisted Common collection;
reference lists use the same app and record ACLs. Runtime validates declared
fields, primitive types, options, dates/email and JSON before dispatch. Common
completion is synchronous; workflow requests remain accepted/pending.

Kanban declares `groupBy`, ordered `groups` and optional `updateForm` id. Moving
cards requires an authorized matching update form declaring `record_id` and the
group field. Additional required fields disable direct moves. Both drag/drop and
an accessible per-card status menu use that action, then refresh the data. A
failed move stays visible without changing the displayed record optimistically.

Common task/project/page/file collections follow capability pagination up to a
bounded 5,000-record view, with a visible error above that bound. Other connectors
retain their documented capability collection limits. Reference dropdowns and
widget metrics use those same bounds. Report results display at most 100 rows.
OCR uses an existing app file or pre-extracted text; binary file upload remains
in the file capability UI and is not yet a declarative upload widget. Advanced
schema/query editors remain structured JSON fields.

## Sessions

The console refreshes before access-token expiry or once after a protected 401.
Concurrent requests share refresh; Web Locks coordinate supported browser tabs.
Tokens rotate together. Rejected refresh credentials end the session; transient
upstream errors retain it for retry. Sign-out clears organization caches.
Production IAM lifetime: access 1 hour, refresh 30 days. DX does not mint a
replacement identity or extend IAM expiry.

## Editing existing City/SOS plugins and writing code

Open `/admin/workspaces?product=city` or `?product=sos`, expand **Existing plugins**,
search by name/slug and select the installed page. The same plugin ID is edited;
Save draft uses optimistic version checks and never attempts to change its app.
Publish updates the immutable member snapshot. Organization admins can also use
**Edit in Studio** on a member page to open its exact plugin. App members and
app admins without verified IAM organization-admin status cannot enter Studio.

Add **Custom code** from the component palette and choose **Open Code Studio**.
The editor provides HTML/CSS/JavaScript files, syntax highlighting, line numbers,
autocomplete, examples, test-data JSON, Run/Stop, an isolated preview and console.
**Apply code** updates the local page draft; then **Save draft → Publish**.
Preview fixtures are not published and preview actions do not mutate business data.
Code source and binding lists travel with the portable checksummed plugin bundle;
both product repository validators accept this schema.

The worker API is:

```js
const data = await studio.query("asset-table", { limit: 50 });
console.log(data.rows, data.total); // Metric widgets return count instead.
studio.on("approve", async (event) => {
  const result = await studio.action("approve-form", { record_id: "record-id" });
  console.log(result);
});
studio.render('<button data-event="approve">Approve</button>');
```

Choose readable data widgets and callable forms in **Data & action bindings**.
Query/action IDs must belong to this plugin. Runtime uses the current member's
credential and existing installed-widget APIs, preserving tenant/app checks,
resource allowlists and pinned protected workflow execution. All custom-component
mutations require host confirmation; deletion also requires a checkbox. Query
supports limit (1..100), offset and search; a query returns one page, not a hidden
unbounded data export. Code must handle pagination explicitly when needed.

HTML supports ordinary form controls, content and tables. `data-event` forwards
clicks from buttons, and input/change events from controls, to worker callbacks
as `{type,value,checked,id}`. Keep state in JavaScript and update markup through
`studio.render`; interpolated record strings must be escaped for the intended UI.
HTML is sanitized through an inert template and a bounded tag/attribute allowlist.
Scripts, URLs, inline handlers, images, embedded frames and forms are stripped.
CSS stays inside the iframe. Each source file is limited to 32,768 characters,
all three combined to 65,536, with up to 20 query and 20 action bindings and a
120..1200-pixel height. Existing plugin/bundle size limits still apply.

Authored JS runs in a blob worker inside an opaque iframe, with no DOM, parent
storage, session or credential access. The sandbox response permits only the
hash-verified bootstrap script and evaluated worker code; network, imported
scripts, nested frames, forms and top navigation are denied. The host console
retains its self-only script policy; inline styles support editor/map layouts.
A heartbeat watchdog terminates synchronous loops after about five seconds.
Logs and messages are bounded. Run/Stop removes the preview worker. Arbitrary
npm imports, direct fetch/SQL and external libraries are not supported; use
registered capabilities and server workflow nodes instead. Do not put secrets
in client code: published component source is visible to authorized page users.

For business logic, follow a form binding's **Edit server logic** link, or open
`/admin/workflows?artifact=...`. **JavaScript nodes** edits code directly with the
same editor; **Workflow JSON** retains the graph/connections/settings. **Add code
node** creates an unconnected node, which must be wired in the graph before use.
Save revision delegates persistence to the Tier-1 SDK, and execution stays in
the Tier-1 workflow engine. Republish dependent plugins after reviewing changes;
existing snapshots keep their workflow revision pins until republished.
This authoring path does not establish parity for every archived domain screen.

## Canvas space and admin navigation

Workspace Studio uses the full available admin content width, with a taller
canvas and a narrower component palette. The admin sidebar can collapse to a
72-pixel icon rail using its collapse/expand button; link names remain available
to screen readers and hover titles. The browser remembers this layout preference
across pages and reloads. Mobile navigation always opens at its full width.
Code Studio labels the selected widget ID; Apply code changes only that widget.
Other widgets and the page's app, roles and workflow bindings stay untouched.

## Studio header and named actions

The sticky Studio header contains the workspace selector, plugin selector,
**New plugin**, searchable **Plugin library**, import, page settings, preview,
save, publish and bundle controls. The library and settings open as dialogs so
the canvas remains the main working area. New plugin starts a separate draft in
the selected app; saving creates it, publishing and organization installation
remain explicit steps.

Open **Actions** beside Components/Layers and choose **New action**. A page supports
40 visual components and 128 named actions. Every declarative data source and
business interaction uses an explicit action in the immutable published page:

| Widget interaction | Registry binding |
| --- | --- |
| Initial read, search, pagination | `onLoad`: query preset or read-only function |
| Form submission | `onSubmit`: matching create/update/delete/execute preset |
| Row details / map feature | `onRowClick`: inspect-record preset |
| Kanban move | `onChange`: update preset with event row/value mappings |
| CSV export | `onExport`: export preset |
| Button | `onClick`: named action |
| Navigation / tabs | each link's `actionId`: navigation preset |
| Select reference values | field's `optionsAction`: query of its `optionsResource` |

The Actions list shows kind, source and usage. The inspector selects an existing
action for each event; an unassigned event stays disabled. Publishing refuses
missing or incompatible bindings. Retired capability embeds cannot be published:
use the declarative Common template or a deliberately authored code widget.

Query presets explicitly declare `source` from their target's product catalog
binding. There are no arbitrary URLs, dataset ids, SQL strings or credentials in
widget settings. City and SOS sources/memberships remain separate. Query mappings
support limit, offset, search, status, sortBy and sortDirection; sorting only accepts
published columns. Reference queries explicitly name their form and source.

Mappings accept static JSON/text, current form inputs, selected records, event paths
(`values.status`, `row.id`, `value`) and previous action results. Required mappings
fail if missing; optional mappings are omitted. Built-in transforms cover string,
number, boolean, JSON, date, trim, uppercase and lowercase. The server rejects
undeclared payload fields and overrides of a preset's fixed values.

Native presets include read, create, update, delete, execute workflow, navigate,
open form, inspect record, refresh, reset/set form inputs, notify, export, ordered
sequence and conditional branching. Sequences reference existing actions and
reject cycles/depth over 12 and chains above 128 native executions; writes require confirmation, with a deletion checkbox.
Domain writes retain the reviewed workflow revision/checksum and caller authority.

For custom query transformations, choose **JavaScript function / query**, declare
readable sources, and connect it to `onLoad`. It must declare no callable forms:

```javascript
async function run(input, studio) {
  const data = await studio.query("assets-table", { limit: 50 });
  const rows = data.rows.filter(row => row.status === "active");
  return { rows, total: rows.length, columns: data.columns };
}
```

Functions connected to buttons may declare callable forms and use
`await studio.action("form-id", values)`. `input.widgets`, `input.selected`,
`input.event` and `input.results` expose the current action context. Functions run
in the isolated worker; presets run through the native registry executor. Source
limits are 16,000 characters, context 12,000, results 20,000 and execution 30 seconds
in addition to the worker watchdog. Action Studio offers sample inputs, query
fixtures, simulated writes, result and console. No credentials/network/DOM/npm
access are exposed to function code.

Every installed read/write request carries a registry action ID. The server checks
it against the published snapshot; missing, forged, wrong-source or foreign-page
bindings fail closed. The code-widget exception still requires an explicit
`code:<widget-id>` binding declared by that published code widget, and retains all
product, tenant, role, source and workflow checks. It is not an anonymous API bypass.

**Create actions for legacy bindings** is an explicit draft conversion, followed by
Save and Publish. Runtime never synthesizes hidden actions. Conversion preserves
components and server workflow pins and is idempotent. Portable bundles preserve
events, source declarations, mappings, functions and chart settings. The operator's
production migration publishes new immutable versions and audits each plugin;
installs, members, workflow artifacts and business data are preserved.

Charts support bar, line, area, pie and donut. The first selected column is the
category and up to five numeric columns are series. Aggregation supports none,
count, sum and average over the loaded query page, with up to 50 displayed
categories. The chart labels this scope; it does not claim a whole-dataset total.
Use a query function or reviewed server report for other transformations. Charts
include labels, legends, point tooltips and an accessible data table.

## Buildability audit

[LCDP_BUILDABILITY_AUDIT.md](LCDP_BUILDABILITY_AUDIT.md) distinguishes verified configuration buildability for the 30 current pages from advanced legacy business features that still need implementation or acceptance testing. It also records the published workflow-pin repair and current preview limitations.

## Native files and batch workflows

Use a File field in a form and select its named Upload action. Select accepted
MIME types and a size limit (up to 20 MiB). Selecting a CSV previews its rows
locally; Upload transfers bytes through the published app action. A form stores
the returned file ID only after upload succeeds. File IDs from another app are
rejected. For downloads, create a Download action on a data source and map its
single `file_id` from the selected row, then attach the action to a button.

For large imports, a Batch action targets an Execute form and names its numeric
offset field. Its pinned workflow returns a result object with an advancing
`nextOffset`, or omits it when finished. Runtime waits for each execution,
confirms the batch once, aggregates import counts/errors and preserves the next
offset on failure. Replaying the City CSV workflow skips existing stable asset
IDs. CSV import/report sources support up to 50,000 rows. CSV and JSON report
exports create real stored artifacts, rather than marking a metadata record as
completed without bytes. Report formats and file limits are enforced explicitly.

## Native structured field editors

For a JSON form field, choose **Form schema designer**, **Report query builder**
or **Map geometry editor** in the field properties. These are native fields;
their values are submitted through the form's existing named action. Switching
between Visual and JSON preserves advanced settings that the visual controls do
not edit. `selectionPath` explicitly binds a field to a property of the selected
record, including nested paths such as `metadata.area`. Late record-detail reads
fill untouched fields without replacing edits already in progress.

The schema designer supports field names, labels, types, choices, required fields,
formats, numeric bounds and additional properties. The backend validates draft-7
schemas and submissions, including integer/object/nested types, string lengths,
formats, local references and `additionalProperties`. Invalid schemas are rejected
before saving. Existing `visibleWhen` behavior is preserved. Remote schema loading,
asynchronous validation and coercion of submitted values are disabled.

The query builder controls aggregation, value/group fields, result limits and
exact-match filters. Choose a filter's type explicitly: Text, Number, Boolean or
Null. Numeric-looking text retains its type and leading zeros. The data source
continues to come from the authorized report definition.

The geometry editor draws Point, LineString and Polygon shapes, supports dragging
vertices, coordinate inputs, undo and cancellation, and keeps JSON access for
Multi geometries and polygons with holes. WGS84 coordinate ranges, closed rings
and the 5,000-position limit are checked at the server boundary. Applying a shape
changes the field; saving still requires its declared form action and workflow.
Map tiles come from the platform's authenticated map capability. Tile failure is
displayed and does not prevent coordinate editing. The geometry editor itself
does not add a spatial-query connector; City GIS uses the dataset spatial API
below.

## Server-side spatial queries for GIS records

City GIS can query records by location without loading a whole dataset into the
browser. This is a generic Tier-2 dataset capability; no City-specific field or
rule is stored in DX.

Configure the geometry path on the dataset (a dotted path inside `record.data`,
1..6 segments of `[A-Za-z_][A-Za-z0-9_]{0,63}`):

```json
POST /v1/capabilities/datasets
{ "slug": "city-assets", "name": "City assets", "entityType": "Asset",
  "license": "CC-BY-4.0", "public": true, "geo": { "field": "geometry" } }

PATCH /v1/capabilities/datasets/city-assets
{ "geo": { "field": "metadata.area" } }   // { "geo": null } removes the binding
```

Each configured dataset gets one SynapseBase PostGIS collection,
`synapsedx_geo_<datasetId>` (sanitized and bounded to Tier-1's 64-character
collection names). DX keeps no spatial database, cache or file of its own.
Features store `{id: recordId, properties: {recordId, datasetId, published,
updatedAt}, geometry}`.

Record writes keep the index in step:

- create, update and bulk create validate the geometry with the shared editor
  validator before any record write; an invalid value returns
  `400 invalid_geometry` and nothing is stored.
- a missing/`null` geometry removes the feature; delete, retention purge and a
  purging dataset delete remove it as well.
- an update that changes `publish` refreshes the indexed `published` flag.
- index sync is best-effort. If PostGIS is unavailable the Base record write
  still succeeds, DX logs a warning, and `records/spatial/reindex` repairs the
  index. Index operations are scoped to one dataset collection, so one tenant's
  index failure can never expose or delete another dataset's features.

Routes (read access uses the normal dataset record authorization):

| Route | Method | Purpose |
| --- | --- | --- |
| `/v1/capabilities/datasets/:id/records/spatial` | POST | near / bbox / within query |
| `/v1/capabilities/datasets/:id/records/spatial/reindex` | POST | write access; rebuild/repair the index |
| `/v1/capabilities/datasets/:id/records/spatial/status` | GET | configured field, collection, feature count and extent |

Query body is exactly one of:

```json
{ "mode": "near", "lat": 21.0285, "lng": 105.8542, "radiusMeters": 2000, "limit": 100 }
{ "mode": "bbox", "bbox": [105.84, 21.02, 105.87, 21.04], "limit": 100 }
{ "mode": "within", "geometry": { "type": "Polygon", "coordinates": ["closed WGS84 ring"] }, "limit": 100 }
```

`limit` is 1..500 (default 100), `radiusMeters` 1..100000, bbox is
`[west, south, east, north]` with valid WGS84 ranges and ordered axes, and
`within` accepts only Polygon or MultiPolygon. A dataset without `geo` returns
`400 geo_not_configured`.

The response is
`{type: "FeatureCollection", features: [{type: "Feature", id, geometry,
properties: {recordId, distanceMeters?}}], items, total, limit, mode}`.
`items` is the normal record response shape. Hits are re-checked against the
record store: deleted or reassigned ids are dropped, draft readers
(`canReadRecordDrafts`) may see withheld rows, and every other caller only sees
published or inherited-published rows. The indexed `published` flag is a hint;
the record and dataset state at query time is authoritative, so a stale index
never widens visibility.

`reindex` pages at most 5,000 records per call and returns
`{dataset_id, collection, offset, scanned, indexed, removed, skipped, failed,
truncated}`. When `truncated` is true, call it again with
`{ "offset": <previous offset + scanned> }`; stale-feature cleanup only runs on
a complete pass from offset 0 because unread records cannot be distinguished
from deleted ones. Reindex after changing `geo.field` or repairing a PostGIS
outage.

`status` returns `{configured, field, collection, features?, extent?}`; stats
are best-effort, so `features` may be absent while PostGIS is unreachable.
