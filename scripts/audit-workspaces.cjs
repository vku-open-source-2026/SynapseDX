// SPDX-License-Identifier: Apache-2.0
// Offline audit only. Sibling repositories are authoring inputs, never runtime imports.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parseBundle, buildBundle, checksumOf, workspaceLimits, canonicalJson } = require('../apps/capabilities-service/dist/src/workspace-plugins');
const { actionGovernanceErrors } = require('../apps/capabilities-service/dist/src/studio-actions');
const { workflowGraphChecksum } = require('../apps/capabilities-service/dist/src/routes/workflow-artifacts');
const workspace = path.resolve(__dirname, '../..');
const pages = [];
for (const [repository, product] of [['SynapseCity', 'city'], ['SynapseCitySOS', 'sos']]) {
  const directory = path.join(workspace, repository, 'plugins');
  const workflows = fs.readdirSync(path.join(directory, 'workflows'))
    .filter(file => file.endsWith('.workflow.json'))
    .map(file => JSON.parse(fs.readFileSync(path.join(directory, 'workflows', file), 'utf8')));
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.plugin.json')).sort()) {
    const input = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    const parsed = parseBundle(input, workspaceLimits());
    const plugin = parsed.plugin;
    assert.equal(plugin.product, product);
    assert.deepEqual(actionGovernanceErrors(plugin.widgets), [], plugin.slug);
    // Simulate import-time resolution: buildBundle accepts installed bindings.
    const refs = new Map();
    const bound = { ...plugin, widgets: plugin.widgets.map((widget, index) => {
      if (!widget.workflowRef) return widget;
      const { workflowRef, ...base } = widget;
      const id = `audit-artifact-${index}`;
      refs.set(id, workflowRef);
      return { ...base, workflowArtifactId: id };
    }) };
    const rebuilt = parseBundle(buildBundle(bound, refs), workspaceLimits()).plugin;
    assert.ok(canonicalJson(rebuilt) === canonicalJson(plugin), `${plugin.slug}: build/import changed configuration`);
    for (const form of plugin.widgets.filter(widget => widget.type === 'form' && !widget.resource.startsWith('common'))) {
      assert.ok(form.workflowRef, `${plugin.slug}/${form.id}: missing portable workflow`);
      assert.ok(workflows.some(workflow => workflow.name === form.workflowRef.name), `${plugin.slug}/${form.id}: workflow source missing`);
    }
    pages.push({
      product, slug: plugin.slug,
      visualWidgets: plugin.widgets.filter(widget => widget.type !== 'action').length,
      actions: plugin.widgets.filter(widget => widget.type === 'action').length,
      forms: plugin.widgets.filter(widget => widget.type === 'form').length,
      customCodeWidgets: plugin.widgets.filter(widget => widget.type === 'code').length,
      opaqueEmbeds: plugin.widgets.filter(widget => widget.type === 'capability').length,
      configurationBuildImport: 'passed',
      productionBusinessExecution: 'not_exercised',
      legacyBusinessParity: 'not_established',
    });
  }
}
assert.equal(pages.length, 30);
assert.ok(pages.every(page => !page.customCodeWidgets && !page.opaqueEmbeds));
let publishedInventory;
if (process.argv[2] === '--inventory') {
  // Operator supplies a read-only SDK export, kept outside git with mode 0600.
  const inventory = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const artifacts = new Map(inventory.synapsedx_capability_workflow_artifacts.map(row => [row.data.id, row.data]));
  const refs = new Map([...artifacts].map(([id, artifact]) => [id, {
    name: artifact.name, ...(artifact.slug ? { slug: artifact.slug } : {}), checksum: artifact.portableChecksum || artifact.checksum,
  }]));
  let plugins = 0, pinnedForms = 0;
  for (const { data: plugin } of inventory.synapsedx_capability_workspace_plugins) {
    if (plugin.status !== 'published') continue;
    const snapshot = inventory.synapsedx_capability_workspace_plugin_snapshots
      .find(row => row.data.pluginId === plugin.id && row.data.version === plugin.publishedVersion)?.data;
    assert.ok(snapshot, `${plugin.slug}: published snapshot missing`);
    assert.deepEqual(actionGovernanceErrors(snapshot.widgets), [], plugin.slug);
    assert.ok(inventory.synapsedx_capability_workspace_installs.some(row => row.data.pluginId === plugin.id && row.data.tenant === plugin.tenant && row.data.product === plugin.product), `${plugin.slug}: matching installation missing`);
    const definition = { product: snapshot.product, name: snapshot.name, slug: snapshot.slug, audience: snapshot.audience, roles: snapshot.roles, widgets: snapshot.widgets };
    assert.ok(checksumOf(definition) === snapshot.checksum && snapshot.checksum === plugin.checksum, `${plugin.slug}: snapshot checksum mismatch`);
    for (const form of snapshot.widgets.filter(widget => widget.type === 'form' && !widget.resource.startsWith('common'))) {
      const artifact = artifacts.get(form.workflowArtifactId);
      assert.ok(form.workflowArtifactRevision && form.workflowArtifactChecksum && artifact, `${plugin.slug}/${form.id}: published workflow pin missing`);
      assert.ok(artifact.tenant === plugin.tenant && artifact.managedBy === 'technical' && artifact.accessMode === 'owner-only', `${plugin.slug}/${form.id}: artifact ownership invalid`);
      assert.ok(form.workflowArtifactRevision === artifact.revision && form.workflowArtifactChecksum === artifact.checksum && form.workflowArtifactPortableChecksum === artifact.portableChecksum, `${plugin.slug}/${form.id}: artifact changed after review`);
      assert.ok(workflowGraphChecksum(artifact) === artifact.checksum, `${plugin.slug}/${form.id}: graph checksum mismatch`);
      pinnedForms++;
    }
    const exported = parseBundle(buildBundle({ ...plugin, widgets: snapshot.widgets }, refs), workspaceLimits()).plugin;
    const repository = plugin.product === 'city' ? 'SynapseCity' : 'SynapseCitySOS';
    const source = parseBundle(JSON.parse(fs.readFileSync(path.join(workspace, repository, 'plugins', plugin.slug + '.plugin.json'), 'utf8')), workspaceLimits()).plugin;
    assert.ok(canonicalJson(exported) === canonicalJson(source), `${plugin.slug}: source differs from published configuration`);
    plugins++;
  }
  assert.equal(plugins, 30);
  publishedInventory = { plugins, pinnedForms, sourceMatchesPublished: true, businessWritesExercised: false };
}
console.log(JSON.stringify({
  scope: 'Source bundles, schema, action governance, portable workflow source and build/import round-trip. No live writes.',
  pages: pages.length,
  actions: pages.reduce((sum, page) => sum + page.actions, 0),
  ...(publishedInventory ? { publishedInventory } : {}),
  results: pages,
}, null, 2));
