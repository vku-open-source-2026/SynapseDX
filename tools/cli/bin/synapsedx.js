#!/usr/bin/env node
/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * synapsedx CLI — zero dependencies, Node 18+ (global fetch).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = (() => {
  try {
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const CONF_DIR = path.join(os.homedir(), '.synapsedx');
const CONF_FILE = path.join(CONF_DIR, 'config.json');

// ---------- config ----------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveConfig(cfg) {
  fs.mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 });
  // Credentials on disk: owner-only (0600). Token/API key in this file is a
  // bearer secret — never print it (see cmdConfig redaction below).
  fs.writeFileSync(CONF_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONF_FILE, 0o600); } catch { /* non-POSIX (win) */ }
}
function baseUrl(opts) {
  return (opts.base || process.env.SYNAPSEDX_BASE_URL || loadConfig().baseUrl || 'http://localhost:8080').replace(/\/$/, '');
}
function authHeaders(opts) {
  const cfg = loadConfig();
  const token = opts.token || process.env.SYNAPSEDX_TOKEN || cfg.token;
  const apiKey = opts.apikey || process.env.SYNAPSEDX_API_KEY || cfg.apiKey;
  const h = { 'Content-Type': 'application/json', Connection: 'close' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (apiKey) h['X-API-Key'] = apiKey;
  return h;
}

// ---------- http ----------
async function req(method, p, body, opts) {
  let r;
  try {
    r = await fetch(baseUrl(opts) + p, {
      method,
      headers: authHeaders(opts),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`network ${p}: ${e.message || e}`);
  }
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${p}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}
const GET = (p, o) => req('GET', p, undefined, o);
const POST = (p, b, o) => req('POST', p, b, o);
const DEL = (p, o) => req('DELETE', p, undefined, o);

// ---------- output ----------
function out(data, opts, pick) {
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data === null || data === undefined) {
    console.log('(empty)');
    return;
  }
  if (Array.isArray(data)) {
    if (!data.length) {
      console.log('(empty)');
      return;
    }
    const cols = pick || Object.keys(data[0]).filter((k) => !/document|context/i.test(k));
    console.log(cols.join('\t'));
    for (const row of data) {
      console.log(cols.map((c) => fmt(row[c])).join('\t'));
    }
    return;
  }
  if (typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) console.log(`${k}: ${fmt(v)}`);
    return;
  }
  console.log(String(data));
}
function fmt(v) {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 40 ? s.slice(0, 37) + '...' : s;
}
function need(v, name) {
  if (!v) {
    console.error(`missing <${name}>`);
    process.exit(2);
  }
  return v;
}

// ---------- args ----------
function parse(argv) {
  const args = [];
  const opts = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--base' || a === '--token' || a === '--apikey') opts[a.slice(2)] = argv[++i];
    else if (a.startsWith('--base=')) opts.base = a.slice(7);
    else if (a.startsWith('--token=')) opts.token = a.slice(8);
    else if (a.startsWith('--apikey=')) opts.apikey = a.slice(9);
    else if (a.startsWith('--context=')) (opts.context ??= {}), Object.assign(opts.context, parseKV(a.slice(10)));
    else if (a === '--context') {
      const v = argv[++i];
      if (!v) throw new Error('missing value for --context k=v');
      (opts.context ??= {}), Object.assign(opts.context, parseKV(v));
    }
    else if (a === '--file') opts.file = argv[++i];
    else if (a.startsWith('--file=')) opts.file = a.slice(7);
    else if (a.startsWith('--limit=')) opts.limit = a.slice(8);
    else if (a === '--limit') opts.limit = argv[++i];
    else if (a.startsWith('--actor=')) opts.actor = a.slice(8);
    else if (a === '--actor') opts.actor = argv[++i];
    else if (a.startsWith('--name=')) opts.name = a.slice(7);
    else if (a === '--name') opts.name = argv[++i];
    else if (a.startsWith('--template=')) opts.template = a.slice(11);
    else if (a === '--template') opts.template = argv[++i];
    else if (a.startsWith('--email=')) opts.email = a.slice(8);
    else if (a === '--email') opts.email = argv[++i];
    else if (a.startsWith('--org=')) opts.org = a.slice(6);
    else if (a === '--org') opts.org = argv[++i];
    else if (a === '--label') opts.label = argv[++i];
    else if (a.startsWith('--label=')) opts.label = a.slice(8);
    else args.push(a);
  }
  return { args, opts };
}
function parseKV(s) {
  const i = s.indexOf('=');
  if (i < 0) throw new Error(`bad --context '${s}' (want k=v)`);
  return { [s.slice(0, i)]: s.slice(i + 1) };
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------- commands ----------
async function cmdLogin(o) {
  const email = o.email || o._[0];
  need(email, 'email');
  const org = o.org || o._[1] || 'acme';
  const r = await POST('/v1/auth/login', { email, orgSlug: org }, o);
  const cfg = loadConfig();
  cfg.baseUrl = baseUrl(o);
  cfg.token = r.accessToken;
  if (r.refreshToken) cfg.refreshToken = r.refreshToken;
  delete cfg.apiKey;
  saveConfig(cfg);
  if (!o.json) console.log(`logged in as ${r.user.email} (token saved to ${CONF_FILE})`);
  else console.log(JSON.stringify(r, null, 2));
}
async function cmdUseKey(o) {
  const key = o._[0];
  need(key, 'key');
  const cfg = loadConfig();
  cfg.baseUrl = baseUrl(o);
  cfg.apiKey = key;
  delete cfg.token;
  saveConfig(cfg);
  if (!o.json) console.log(`api key saved to ${CONF_FILE}`);
}
async function cmdMe(o) {
  out(await GET('/v1/auth/me', o), o);
}
async function cmdOrgs(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'list') return out(await GET('/v1/orgs', o), o, ['slug', 'display_name', 'id']);
  if (sub === 'create') {
    const [slug, name] = rest;
    need(slug, 'slug');
    return out(await POST('/v1/orgs', { slug, displayName: name || slug }, o), o);
  }
  throw new Error(`unknown orgs subcommand '${sub}'`);
}
async function orgId(o, maybeId) {
  if (maybeId) return maybeId;
  const orgs = await GET('/v1/orgs', o);
  if (!orgs.length) throw new Error('no organizations (login first?)');
  const bySlug = orgs.find((x) => x.slug === (process.env.DEMO_ORG_SLUG || 'acme'));
  return (bySlug || orgs[0]).id;
}
async function cmdAccounts(o) {
  const [sub, ...rest] = o._;
  if (sub === 'create') {
    const org = rest.length > 1 ? rest[0] : await orgId(o);
    const slug = rest.length > 1 ? rest[1] : rest[0];
    const name = rest.length > 2 ? rest[2] : slug;
    need(slug, 'slug');
    return out(await POST(`/v1/orgs/${org}/accounts`, { slug, displayName: name }, o), o);
  }
  const org = sub && sub !== 'list' ? sub : await orgId(o);
  return out(await GET(`/v1/orgs/${encodeURIComponent(org)}/accounts`, o), o, ['slug', 'display_name', 'id']);
}
async function cmdUsers(o) {
  const [sub, ...rest] = o._;
  if (sub === 'create') {
    const [org, email, name] = rest;
    need(org, 'org'); need(email, 'email');
    return out(await POST(`/v1/orgs/${encodeURIComponent(org)}/users`, { email, displayName: name || email }, o), o);
  }
  if (sub === 'policies') {
    need(rest[0], 'user-id');
    return out(await GET(`/v1/users/${encodeURIComponent(rest[0])}/policies`, o), o);
  }
  const org = await orgId(o, sub && sub !== 'list' ? sub : undefined);
  return out(await GET(`/v1/orgs/${encodeURIComponent(org)}/users`, o), o, ['email', 'display_name', 'id']);
}
async function cmdRefresh(o) {
  const cfg = loadConfig();
  const rt = o._[0] || process.env.SYNAPSEDX_REFRESH_TOKEN || cfg.refreshToken;
  need(rt, 'refresh-token (arg | $SYNAPSEDX_REFRESH_TOKEN)');
  const r = await POST('/v1/auth/refresh', { refreshToken: rt }, o);
  cfg.baseUrl = baseUrl(o);
  cfg.token = r.accessToken;
  if (r.refreshToken) cfg.refreshToken = r.refreshToken;
  delete cfg.apiKey;
  saveConfig(cfg);
  if (!o.json) console.log(`token rotated (saved to ${CONF_FILE})`);
  else console.log(JSON.stringify(r, null, 2));
}
async function cmdLogoutAll(o) {
  const cfg = loadConfig();
  const rt = o._[0] || process.env.SYNAPSEDX_REFRESH_TOKEN || cfg.refreshToken;
  need(rt, 'refresh-token (arg | $SYNAPSEDX_REFRESH_TOKEN)');
  const r = await POST('/v1/auth/logout-all', { refreshToken: rt }, o);
  delete cfg.refreshToken;
  saveConfig(cfg);
  out(r, o);
}
async function cmdVerify(o) {
  out(await GET('/v1/auth/verify', o), o);
}
async function cmdRoles(o) {
  const [sub, ...rest] = o._;
  if (sub === 'create') {
    const [account, slug] = rest;
    need(account, 'account'); need(slug, 'slug');
    return out(await POST(`/v1/accounts/${encodeURIComponent(account)}/roles`, { slug }, o), o);
  }
  if (sub === 'delete') {
    need(rest[0], 'role-id');
    return out(await DEL(`/v1/roles/${encodeURIComponent(rest[0])}`, o), o);
  }
  need(sub, 'account');
  return out(await GET(`/v1/accounts/${encodeURIComponent(sub)}/roles`, o), o, ['slug', 'id']);
}
async function cmdPolicies(o) {
  const [sub, ...rest] = o._;
  if (sub === 'create') {
    const [account, slug] = rest;
    need(account, 'account'); need(slug, 'slug'); need(o.file, '--file policy.json');
    return out(await POST(`/v1/accounts/${encodeURIComponent(account)}/policies`, { slug, document: readJson(o.file) }, o), o);
  }
  if (sub === 'delete') {
    need(rest[0], 'policy-id');
    return out(await DEL(`/v1/policies/${encodeURIComponent(rest[0])}`, o), o);
  }
  need(sub, 'account');
  return out(await GET(`/v1/accounts/${encodeURIComponent(sub)}/policies`, o), o, ['slug', 'id']);
}
async function cmdAttach(o) {
  need(o._[0], 'role-id'); need(o._[1], 'policy-id');
  return out(await POST(`/v1/roles/${encodeURIComponent(o._[0])}/attach`, { policyId: o._[1] }, o), o);
}
async function cmdAssign(o) {
  need(o._[0], 'user-id'); need(o._[1], 'role-id');
  return out(await POST(`/v1/users/${encodeURIComponent(o._[0])}/assign`, { roleId: o._[1] }, o), o);
}
async function cmdAuthz(o) {
  const [user, action, resource] = o._;
  need(user, 'user-id'); need(action, 'action'); need(resource, 'resource');
  return out(await POST('/v1/authorize', { userId: user, action, resource, context: o.context }, o), o);
}
async function cmdSim(o) {
  need(o.file, '--file policy.json');
  const [action, resource] = o._;
  need(action, 'action'); need(resource, 'resource');
  const raw = readJson(o.file);
  const docs = Array.isArray(raw) ? raw : [raw];
  return out(await POST('/v1/authorize/dry-run', { documents: docs, action, resource, context: o.context }, o), o);
}
async function cmdAudit(o) {
  const qs = `?limit=${o.limit || 50}${o.actor ? `&actor=${encodeURIComponent(o.actor)}` : ''}`;
  return out(await GET(`/v1/audit${qs}`, o), o, ['created_at', 'actor_id', 'action', 'decision']);
}
async function cmdKeys(o) {
  const [sub, ...rest] = o._;
  if (sub === 'create') {
    need(rest[0], 'account');
    const r = await POST(`/v1/accounts/${encodeURIComponent(rest[0])}/keys`, { name: o.name || o.label || 'cli', scopes: ['*'] }, o);
    if (!o.json) console.log(`SAVE THIS KEY (shown once):\n${r.apiKey}\nid: ${r.id}`);
    else console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (sub === 'revoke' || sub === 'delete') {
    need(rest[0], 'key-id');
    return out(await DEL(`/v1/keys/${encodeURIComponent(rest[0])}`, o), o);
  }
  if (sub === 'verify') {
    need(rest[0] || o.apikey, 'api-key (arg or --apikey)');
    return out(await POST('/v1/keys/verify', { apiKey: rest[0] || o.apikey }, o), o);
  }
  throw new Error(`usage: keys create <account> [--name N] | keys revoke <key-id> | keys verify <api-key>`);
}
async function cmdSa(o) {
  const [sub, ...rest] = o._;
  if (sub === 'create') {
    need(rest[0], 'account'); need(rest[1], 'slug');
    return out(await POST(`/v1/accounts/${encodeURIComponent(rest[0])}/service-accounts`, { slug: rest[1] }, o), o);
  }
  if (sub === 'token') {
    need(rest[0], 'sa-id');
    const r = await POST(`/v1/service-accounts/${encodeURIComponent(rest[0])}/token`, {}, o);
    if (!o.json) console.log(`SAVE THIS TOKEN (short-lived):\n${r.accessToken}`);
    else console.log(JSON.stringify(r, null, 2));
    return;
  }
  need(sub, 'account');
  return out(await GET(`/v1/accounts/${encodeURIComponent(sub)}/service-accounts`, o), o, ['slug', 'id']);
}
async function cmdWorkflows(o) {
  const [sub, ...rest] = o._;
  if (!sub || sub === 'list') {
    const r = await GET('/v1/workflows', o);
    return out(Array.isArray(r) ? r : r.data || r, o, ['id', 'name', 'active']);
  }
  if (sub === 'create') {
    if (o.template) {
      return out(await POST('/v1/workflows', { template: o.template, name: o.name }, o), o);
    }
    if (o.file) {
      const raw = readJson(o.file);
      // Accept either a full body ({template|definition, name}) or a bare definition.
      const body = raw && (raw.template || raw.definition) ? raw : { name: o.name || 'synapsedx-workflow', definition: raw };
      if (o.name && !body.name) body.name = o.name;
      return out(await POST('/v1/workflows', body, o), o);
    }
    throw new Error(`workflows create needs --template T [--name N] or --file definition.json [--name N]`);
  }
  if (['get', 'activate', 'deactivate'].includes(sub)) {
    need(rest[0], 'workflow-id');
    const method = sub === 'get' ? 'GET' : 'POST';
    const suf = sub === 'get' ? '' : `/${sub}`;
    const id = encodeURIComponent(rest[0]);
    if (method === 'GET') return out(await GET(`/v1/workflows/${id}`, o), o);
    return out(await req('POST', `/v1/workflows/${id}${suf}`, {}, o), o);
  }
  if (sub === 'exec' || sub === 'execute') {
    need(rest[0], 'workflow-id');
    return out(await POST(`/v1/workflows/${encodeURIComponent(rest[0])}/execute`, {}, o), o);
  }
  throw new Error(`unknown workflows subcommand '${sub}'`);
}
async function cmdTemplates(o) {
  const [sub, ...rest] = o._;
  if (sub && sub !== 'list') {
    return out(await GET(`/v1/templates/${encodeURIComponent(sub)}`, o), o);
  }
  if (sub === 'list' && rest[0]) {
    return out(await GET(`/v1/templates/${encodeURIComponent(rest[0])}`, o), o);
  }
  return out(await GET('/v1/templates', o), o, ['name', 'description']);
}
async function cmdExecutions(o) {
  const [sub, ...rest] = o._;
  if (sub && sub !== 'list') {
    return out(await GET(`/v1/executions/${encodeURIComponent(sub)}`, o), o);
  }
  const qs = o.limit ? `?limit=${encodeURIComponent(o.limit)}` : '';
  const r = await GET(`/v1/executions${qs}`, o);
  return out(Array.isArray(r) ? r : r.data || r, o, ['id', 'status', 'workflowId']);
}
async function cmdConfig() {
  const cfg = loadConfig();
  const redacted = { file: CONF_FILE, baseUrl: cfg.baseUrl };
  if (cfg.token) redacted.token = '*** (saved)';
  if (cfg.apiKey) redacted.apiKey = '*** (saved)';
  if (cfg.refreshToken) redacted.refreshToken = '*** (saved)';
  console.log(JSON.stringify(redacted, null, 2));
}

const COMMANDS = {
  login: { fn: cmdLogin, use: 'login --email E [--org ORG] [--base URL]', doc: 'Dev login, save token + refresh' },
  refresh: { fn: cmdRefresh, use: 'refresh [refresh-token]', doc: 'Rotate access token (atomic server-side)' },
  'logout-all': { fn: cmdLogoutAll, use: 'logout-all [refresh-token]', doc: 'Revoke ALL sessions of token owner' },
  verify: { fn: cmdVerify, use: 'verify', doc: 'Check current Bearer / API key' },
  'use-key': { fn: cmdUseKey, use: 'use-key <api-key>', doc: 'Save API key instead of token' },
  logout: { fn: async () => { saveConfig({ baseUrl: loadConfig().baseUrl }); console.log('logged out'); }, use: 'logout', doc: 'Clear saved credentials' },
  config: { fn: cmdConfig, use: 'config', doc: 'Show saved config (secrets redacted)' },
  whoami: { fn: cmdMe, use: 'whoami', doc: 'Current user (/v1/auth/me)' },
  orgs: { fn: cmdOrgs, use: 'orgs [list|create <slug> [name]]', doc: 'Organizations' },
  accounts: { fn: cmdAccounts, use: 'accounts [org] [list] | accounts create [org] <slug> [name]', doc: 'Accounts' },
  users: { fn: cmdUsers, use: 'users [org] | users create <org> <email> [name] | users policies <user-id>', doc: 'Users + effective policies' },
  roles: { fn: cmdRoles, use: 'roles <account> [list] | roles create <account> <slug> | roles delete <id>', doc: 'Roles' },
  policies: { fn: cmdPolicies, use: 'policies <account> [list] | policies create <account> <slug> --file p.json | policies delete <id>', doc: 'Policies' },
  attach: { fn: cmdAttach, use: 'attach <role-id> <policy-id>', doc: 'Attach policy to role' },
  assign: { fn: cmdAssign, use: 'assign <user-id> <role-id>', doc: 'Assign role to user' },
  authz: { fn: cmdAuthz, use: 'authz <user> <action> <resource> [--context k=v]', doc: 'Authorize check' },
  sim: { fn: cmdSim, use: 'sim --file policy.json <action> <resource> [--context k=v]', doc: 'Policy simulator' },
  audit: { fn: cmdAudit, use: 'audit [--limit N] [--actor ID]', doc: 'Audit log' },
  keys: { fn: cmdKeys, use: 'keys create <account> [--name N] | keys revoke <key-id> | keys verify <api-key>', doc: 'API keys' },
  sa: { fn: cmdSa, use: 'sa <account> [list] | sa create <account> <slug> | sa token <sa-id>', doc: 'Service accounts' },
  workflows: { fn: cmdWorkflows, use: 'workflows [list] | workflows create --template T [--name N] | workflows create --file def.json [--name N] | workflows get|activate|deactivate|exec <id>', doc: 'Workflows (n8n)' },
  executions: { fn: cmdExecutions, use: 'executions [list] [--limit N] | executions <id>', doc: 'Workflow executions' },
  templates: { fn: cmdTemplates, use: 'templates [list|<name>]', doc: 'Built-in templates' },
};

function help() {
  console.log(`synapsedx v${VERSION} — SynapseDX CLI (Apache-2.0)

Usage: synapsedx [--base URL] [--token T | --apikey K] [--json] <command> [args]

Auth defaults: --base > $SYNAPSEDX_BASE_URL > ~/.synapsedx/config.json > http://localhost:8080
`);
  const names = Object.keys(COMMANDS);
  const w = Math.max(...names.map((n) => n.length));
  for (const n of names) console.log(`  ${n.padEnd(w)}  ${COMMANDS[n].doc}\n    usage: synapsedx ${COMMANDS[n].use}`);
  console.log('\nExamples:\n  synapsedx login --email demo@acme.local\n  synapsedx orgs create acme2 "ACME 2"\n  synapsedx authz <uid> workflow:Execute "*" --context team=etl\n  synapsedx --json workflows list');
}

async function main() {
  const { args, opts } = parse(process.argv.slice(2));
  const [cmd, ...rest] = args;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || cmd === 'version' || cmd === '--version') {
    if (cmd === 'version' || cmd === '--version') return console.log(`synapsedx v${VERSION}`);
    return help();
  }
  const c = COMMANDS[cmd];
  if (!c) {
    console.error(`unknown command '${cmd}' — try: synapsedx help`);
    process.exit(2);
  }
  try {
    await c.fn({ ...opts, _: rest });
  } catch (e) {
    console.error(`error: ${e.message || e}`);
    process.exit(1);
  }
}

main();
