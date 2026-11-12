#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Validate git-managed SynapseFlow workflow JSON before deployment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.workflow.json') || f === 'mcp-docs-reader.json')) {
  const file = path.join(dir, name);
  try {
    const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!wf.name || !Array.isArray(wf.nodes) || typeof wf.connections !== 'object') throw new Error('missing name/nodes/connections');
    const mcp = wf.nodes.filter((n) => n.type === 'mcpTrigger' || n.type === 'n8n-nodes-base.mcpTrigger');
    for (const n of mcp) {
      const tool = String(n.parameters?.toolName || n.name || '');
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(tool)) throw new Error(`invalid MCP toolName '${tool}'`);
    }
    if (!wf.nodes.some((n) => String(n.type).includes('Trigger') || n.type === 'mcpTrigger' || n.type === 'webhook' || n.type === 'cron')) throw new Error('no trigger node');
    console.log(`ok ${name}: ${wf.nodes.length} nodes${mcp.length ? ` · MCP ${mcp[0].parameters?.toolName}` : ''}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${name}: ${e.message}`);
  }
}
if (failed) process.exit(1);
