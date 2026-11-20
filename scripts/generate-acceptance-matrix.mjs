#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Generate docs/LCDP_ACCEPTANCE_MATRIX.md from the tracked Tier-3 bundles.
 *
 * Offline and read-only: the sibling SynapseCity / SynapseCitySOS repositories
 * are authoring inputs only (never runtime imports, never modified). One row
 * is emitted per `type:"form"` widget so product acceptance can be planned per
 * binding. The script validates that every form in every bundle produced a
 * row and fails with a clear message when a bundle is unreadable.
 *
 * Usage: node scripts/generate-acceptance-matrix.mjs [--check]
 *   --check  regenerate and exit non-zero when the committed file differs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dxRoot = path.resolve(here, '..');
const workspaceRoot = path.resolve(here, '../..');
const outputPath = path.join(dxRoot, 'docs', 'LCDP_ACCEPTANCE_MATRIX.md');

const REPOSITORIES = [
  { repository: 'SynapseCity', product: 'city', label: 'SynapseCity' },
  { repository: 'SynapseCitySOS', product: 'sos', label: 'SynapseCitySOS' },
];
/** Local Tier-3 harness evidence: executed through the real Tier-1 engine. */
const HARNESS_EVIDENCE = 'scripts/workflow-engine-harness.mts (local Tier-1 engine)';
/** The harness subjects it can execute end-to-end (fake HTTP transport). */
const HARNESS_WORKFLOW_PREFIXES = [
  /^city-incident-/,
  /^city-maintenance-/,
  /^sos-dispatch-/,
  /^sos-event-/,
];
const PENDING = 'pending acceptance test';
const ACTION_VERBS = {
  create: 'Creates',
  update: 'Updates',
  delete: 'Deletes',
  execute: 'Executes',
};

function fail(message) {
  console.error(`generate-acceptance-matrix: ${message}`);
  process.exit(1);
}

function readJson(file, required) {
  if (!fs.existsSync(file)) {
    if (required) fail(`${file} is missing`);
    return null;
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`${file} is unreadable: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
  }
}

/** Status transitions declared inside the workflow source code nodes. */
function statusTokens(workflow) {
  const tokens = [];
  for (const node of workflow?.nodes || []) {
    const code = node?.parameters?.code;
    if (typeof code !== 'string') continue;
    for (const match of code.matchAll(/status['"]?\s*[:=]\s*['"]([a-z_]+)['"]/g)) {
      if (!tokens.includes(match[1])) tokens.push(match[1]);
    }
  }
  return tokens;
}

function cell(value) {
  return String(value ?? '—')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

function rolesCell(roles) {
  return Array.isArray(roles) && roles.length ? roles.join(', ') : '—';
}

/** A short, source-derived line describing the expected domain effect. */
function expectedEffect(form, context) {
  const resource = String(form.resource || '');
  const action = String(form.action || 'create');
  if (resource.startsWith('common')) {
    return `DX common capability \`${resource}.${action}\`: the Tier-2 common connector performs the operation with the member's app permissions (no product workflow).`;
  }
  const ref = form.workflowRef;
  if (!ref || typeof ref.name !== 'string') {
    return 'Unbound: the form stays read-only (no workflow artifact, no domain effect).';
  }
  const workflow = context.workflows.get(ref.name);
  if (!workflow) {
    return `Workflow source \`${ref.name}\` is not committed under plugins/workflows/; acceptance cannot be planned until it is.`;
  }
  const manifestEntry = context.manifestWorkflows.find((entry) => entry.workflow === ref.name);
  const dataset =
    (typeof manifestEntry?.dataset === 'string' && manifestEntry.dataset) ||
    context.genericDatasets[resource] ||
    'an unnamed dataset';
  const statuses = statusTokens(workflow);
  const verb = ACTION_VERBS[action] || 'Runs';
  const statusNote = statuses.length
    ? ` (status \`${statuses.join('`, `')}\`)`
    : '';
  const operationNote = manifestEntry?.operation
    ? ` Declared operation \`${manifestEntry.operation}\` (${manifestEntry.method || 'HTTP'}).`
    : '';
  if (context.dispatcher === ref.name) {
    // The dispatcher is a generic create/update/delete/execute selector; its
    // code mentions every resource's default statuses, so per-form status
    // tokens would be noise rather than the effect of this binding.
    return `Declarative ${action} on \`${resource}\` records in \`${dataset}\` through the pinned workspace-actions dispatcher (product-owned field/status allowlists).`;
  }
  if (action === 'create') {
    return `${verb} a \`${resource}\` record in \`${dataset}\`${statusNote} via workflow \`${ref.name}\`.${operationNote}`;
  }
  if (action === 'delete') {
    return `${verb} a \`${resource}\` record in \`${dataset}\` via workflow \`${ref.name}\`.${operationNote}`;
  }
  return `${verb} a \`${resource}\` record in \`${dataset}\` via workflow \`${ref.name}\`${statusNote}.${operationNote}`;
}

function evidenceFor(form) {
  const ref = form.workflowRef;
  if (
    ref &&
    typeof ref.name === 'string' &&
    HARNESS_WORKFLOW_PREFIXES.some((pattern) => pattern.test(ref.name))
  ) {
    return HARNESS_EVIDENCE;
  }
  return PENDING;
}

const rows = [];
const designNotes = [];
let bundleCount = 0;

for (const repo of REPOSITORIES) {
  const pluginsDir = path.join(workspaceRoot, repo.repository, 'plugins');
  if (!fs.existsSync(pluginsDir)) {
    fail(
      `${repo.repository} plugin bundles not found at ${pluginsDir}. ` +
        'The generator reads the sibling Tier-3 repositories read-only; run it from the workspace that contains them.',
    );
  }
  const workflowsDir = path.join(pluginsDir, 'workflows');
  const manifest = readJson(path.join(workflowsDir, 'manifest.json'), true);
  const design = readJson(path.join(workflowsDir, 'actions.design.json'), false);
  const workflows = new Map();
  for (const file of fs.readdirSync(workflowsDir).sort()) {
    if (!file.endsWith('.workflow.json')) continue;
    const workflow = readJson(path.join(workflowsDir, file), true);
    const name = typeof workflow?.name === 'string' ? workflow.name : file.replace(/\.workflow\.json$/, '');
    workflows.set(name, workflow);
  }
  const context = {
    workflows,
    manifestWorkflows: Array.isArray(manifest?.workflows) ? manifest.workflows : [],
    genericDatasets: manifest?.genericActionWorkflow?.datasets || {},
    dispatcher: manifest?.genericActionWorkflow?.workflow,
  };
  if (design) {
    const gap = String(design.widgetActionGap || 'no gap note')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ');
    designNotes.push(
      `- **${repo.label}** \`plugins/workflows/actions.design.json\`: status \`${design.status || 'unknown'}\` — ${gap}`,
    );
  }

  const bundleFiles = fs
    .readdirSync(pluginsDir)
    .filter((file) => file.endsWith('.plugin.json'))
    .sort();
  if (!bundleFiles.length) fail(`no *.plugin.json bundles found in ${pluginsDir}`);
  for (const file of bundleFiles) {
    const bundle = readJson(path.join(pluginsDir, file), true);
    const plugin = bundle?.plugin;
    if (
      bundle?.format !== 'synapsedx-plugin' ||
      !plugin ||
      !Array.isArray(plugin.widgets)
    ) {
      fail(`${path.join(pluginsDir, file)} is not a readable synapsedx-plugin bundle`);
    }
    bundleCount += 1;
    const forms = plugin.widgets.filter((widget) => widget?.type === 'form');
    const rowsBefore = rows.length;
    for (const form of forms) {
      if (typeof form.id !== 'string' || !form.id) {
        fail(`a form widget in ${file} has no id; cannot build its acceptance row`);
      }
      const binding = form.resource?.startsWith('common')
        ? `capability \`${form.resource}.${form.action || 'create'}\``
        : typeof form.workflowRef?.name === 'string'
          ? `workflowRef \`${form.workflowRef.name}\``
          : 'unbound';
      rows.push({
        product: repo.product,
        page: `${plugin.name} (\`${plugin.slug}\`)`,
        roles: rolesCell(plugin.roles),
        widget: `\`${form.id}\` · ${form.action || 'create'}${form.onSubmit ? ` (submit \`${form.onSubmit}\`)` : ''}`,
        binding,
        effect: expectedEffect(form, context),
        evidence: evidenceFor(form),
        sort: `${repo.product} ${plugin.slug} ${form.id}`,
      });
    }
    // Every form widget must have produced exactly one row.
    if (rows.length - rowsBefore !== forms.length) {
      fail(`${file}: ${forms.length} form widget(s) produced ${rows.length - rowsBefore} rows`);
    }
  }
}

rows.sort((a, b) => a.sort.localeCompare(b.sort));

const generated = `<!-- generated by scripts/generate-acceptance-matrix.mjs — regenerate after Tier-3 bundle changes -->
# LCDP acceptance matrix

One row per \`type:"form"\` widget in every tracked Tier-3 plugin bundle
(${bundleCount} bundles across SynapseCity and SynapseCitySOS, ${rows.length}
form rows). Each row names the binding the capability service will enforce and
the domain effect the bound source declares, so acceptance can be planned per
form instead of per repository. The Evidence column defaults to
\`${PENDING}\`; rows whose bound workflow is executed by the existing local
engine harness cite that suite.

This document is a stop-condition input: a release is not done while rows cite
\`${PENDING}\` without an owner.

## Non-goals

- **QR/NFC scanning** is a future widget contract, not part of this program. No
  bundle declares a scan widget, and this matrix does not plan one.
- **SOS volunteer product pages are read-only by design.** Volunteers' writes
  live in the Common workspace (\`sos-common-workspace\`); the product-bound
  \`sos-volunteer-desk\` page intentionally declares no forms and has no row.

## Action design context

${designNotes.length ? designNotes.join('\n') : '- No actions.design.json was found in either repository.'}

## Matrix

| Product | Page | Roles | Widget · action | Binding | Expected domain effect | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
${rows.map((row) => `| ${cell(row.product)} | ${cell(row.page)} | ${cell(row.roles)} | ${cell(row.widget)} | ${cell(row.binding)} | ${cell(row.effect)} | ${cell(row.evidence)} |`).join('\n')}

## How to regenerate

\`\`\`bash
node scripts/generate-acceptance-matrix.mjs
\`\`\`

The script is offline (no network), reads the sibling Tier-3 repositories
read-only, validates that every form widget in every bundle produced exactly
one row, and fails with a clear message when a bundle is unreadable.
`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (current !== generated) {
    console.error(
      'generate-acceptance-matrix: docs/LCDP_ACCEPTANCE_MATRIX.md is stale; regenerate it with node scripts/generate-acceptance-matrix.mjs',
    );
    process.exit(1);
  }
  console.log(`acceptance matrix is current (${rows.length} form rows)`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, generated);
console.log(`wrote ${path.relative(dxRoot, outputPath)} (${bundleCount} bundles, ${rows.length} form rows)`);
