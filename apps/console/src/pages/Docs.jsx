/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useState } from 'react';
import { Card, Code, PageTitle } from '../components/ui.jsx';

const TABS = ['Console', 'JavaScript', 'Python', 'Go', 'CLI'];

const CONSOLE_DOC = `
# Admin UI + one-line CLI install
open http://localhost:3000            # compose: console service
# sign in: demo@acme.local / org acme  (or an X-API-Key)

curl -fsSL http://localhost:3000/install.sh | sh   # installs the CLI
# ..or run it without installing anything:
npx -y @synapsedx/cli@latest --help

# Point at a different backend when the gateway is not on :8080:
CONSOLE_HOST_PORT=3000 SYNAPSEDX_PUBLIC_BASE_URL=http://localhost:18080 \\
  docker compose up -d console`;

const JS_INSTALL = `npm install @synapsedx/sdk
# or: yarn add @synapsedx/sdk
# or: pnpm add @synapsedx/sdk`;

const JS_QUICKSTART = `import { SynapseDXClient } from '@synapsedx/sdk';

const c = new SynapseDXClient({ baseUrl: 'http://localhost:8080' });

// Login (dev login or seed)
const { accessToken, user } = await c.login('demo@acme.local');
c.setToken(accessToken);

// Create org, authorize user, deploy workflow
await c.createOrg('acme-2', 'ACME 2');
await c.authorize(user.id, 'workflow:Execute', '*');
await c.createWorkflowFromTemplate('webhook-to-log', 'demo');`;

const JS_CONSTRUCTOR = `new SynapseDXClient(opts)

// Options:
//   baseUrl    (string)  — gateway URL, e.g. http://localhost:8080
//   token      (string)  — Bearer JWT
//   apiKey     (string)  — API key (X-API-Key header)
//   timeoutMs  (number)  — per-request timeout (default 15000)

c.setToken(jwt)    // set/replace Bearer token
c.setApiKey(key)   // set/replace API key`;

const JS_AUTH = `// login(email, orgSlug = 'acme')
const { accessToken, refreshToken, user } = await c.login('demo@acme.local', 'acme');

// refresh(refreshToken) — rotate token (atomic, old revoked)
const { accessToken: newAccess, refreshToken: newRefresh } = await c.refresh(refreshToken);

// logout(refreshToken) — revoke one session
await c.logout(refreshToken);

// logoutAll(refreshToken) — revoke ALL sessions
await c.logoutAll(refreshToken);

// verify() — check current token/key without fetching user
await c.verify();

// me() — current user record
const me = await c.me();`;

const JS_ORGS = `// listOrgs() — all organizations
const orgs = await c.listOrgs();

// createOrg(slug, displayName)
const org = await c.createOrg('acme-2', 'ACME 2');

// listAccounts(orgId)
const accounts = await c.listAccounts(org.id);

// createAccount(orgId, slug, displayName)
const account = await c.createAccount(org.id, 'prod', 'Production');

// listUsers(orgId)
const users = await c.listUsers(org.id);

// createUser(orgId, email, displayName?)
const newUser = await c.createUser(org.id, 'alice@acme.local', 'Alice');

// userPolicies(userId) — effective policy documents (debug helper)
const policies = await c.userPolicies(userId);`;

const JS_IAM = `// --- Roles ---
// createRole(accountId, slug, description?)
const role = await c.createRole(accountId, 'etl-runner', 'Runs ETL workflows');

// listRoles(accountId)
const roles = await c.listRoles(accountId);

// deleteRole(roleId)
await c.deleteRole(roleId);

// --- Policies ---
// createPolicy(accountId, slug, document, description?)
const doc = {
  Version: '2012-17-10',
  Statement: [{ Effect: 'Allow', Action: ['workflow:Execute'], Resource: ['*'] }],
};
const policy = await c.createPolicy(accountId, 'wf-exec', doc, 'Allow workflow execution');

// listPolicies(accountId)
const policies = await c.listPolicies(accountId);

// deletePolicy(policyId)
await c.deletePolicy(policyId);

// --- Role-Policy Attachment ---
// attachPolicy(roleId, policyId)
await c.attachPolicy(roleId, policyId);

// assignRole(userId, roleId)
await c.assignRole(userId, roleId);`;

const JS_AUTHZ = `// authorize(userId, action, resource, context?)
const { allowed } = await c.authorize(userId, 'workflow:Execute', '*', { team: 'etl' });

// simulate(documents, action, resource, context?) — dry-run (no user needed)
const result = await c.simulate([policyDoc], 'workflow:Execute', '*');

// listAudit(limit = 50, actor?)
const entries = await c.listAudit(20, userId);`;

const JS_KEYS = `// --- API Keys ---
// createApiKey(accountId, name = 'default', scopes = ['*'])
const { apiKey } = await c.createApiKey(accountId, 'ci-deploy', ['workflow:Execute']);

// revokeApiKey(keyId)
await c.revokeApiKey(keyId);

// listApiKeys(accountId) — id/prefix metadata only, never secrets
const keys = await c.listApiKeys(accountId);

// verifyApiKey(apiKey) — check a raw key
const info = await c.verifyApiKey(apiKey);

// --- Service Accounts ---
// createServiceAccount(accountId, slug, description?)
const sa = await c.createServiceAccount(accountId, 'etl-bot', 'ETL service account');

// listServiceAccounts(accountId)
const sas = await c.listServiceAccounts(accountId);

// serviceAccountToken(saId, scopes = ['*'])
const { accessToken: saToken } = await c.serviceAccountToken(saId, ['workflow:Execute']);`;

const JS_WORKFLOWS = `// listWorkflows()
const wfs = await c.listWorkflows();

// getWorkflow(id)
const wf = await c.getWorkflow(id);

// createWorkflowFromTemplate(template, name?)
const newWf = await c.createWorkflowFromTemplate('webhook-to-log', 'my-webhook');

// createWorkflow(name, definition) — raw n8n definition
const custom = await c.createWorkflow('my-wf', n8nDefinition);

// activateWorkflow(id) / deactivateWorkflow(id)
await c.activateWorkflow(id);
await c.deactivateWorkflow(id);

// updateWorkflow(id, { name?, definition? })
await c.updateWorkflow(id, { name: 'renamed' });

// deleteWorkflow(id)
await c.deleteWorkflow(id);

// executeWorkflow(id, payload?)
const exec = await c.executeWorkflow(id, { url: 'https://example.com/hook' });

// --- Templates ---
// listTemplates()
const templates = await c.listTemplates();

// getTemplate(name)
const tpl = await c.getTemplate('webhook-to-log');

// --- Executions ---
// listExecutions(query?) — e.g. 'limit=20'
const recent = await c.listExecutions('limit=10');

// getExecution(id)
const execution = await c.getExecution(execId);`;

const JS_ERRORS = `// All methods throw Error on failure.
// Error message includes HTTP status and path.
try {
  await c.authorize(userId, 'workflow:Execute', '*');
} catch (e) {
  console.error(e.message); // e.g. "synapsedx 403 /v1: ..."
}`;

const JS_EXAMPLE = `import { SynapseDXClient } from '@synapsedx/sdk';

async function main() {
  const c = new SynapseDXClient({ baseUrl: 'http://localhost:8080' });

  // 1. Login
  const { accessToken, user } = await c.login('demo@acme.local');
  c.setToken(accessToken);

  // 2. Create org + account
  const org = await c.createOrg('acme', 'ACME Corp');
  const account = await c.createAccount(org.id, 'prod', 'Production');

  // 3. Create role + policy
  const role = await c.createRole(account.id, 'wf-runner', 'Workflow runner');
  const policy = await c.createPolicy(account.id, 'wf-exec', {
    Version: '2012-17-10',
    Statement: [{ Effect: 'Allow', Action: ['workflow:Execute'], Resource: ['*'] }],
  });
  await c.attachPolicy(role.id, policy.id);
  await c.assignRole(user.id, role.id);

  // 4. Deploy + execute workflow
  const wf = await c.createWorkflowFromTemplate('webhook-to-log', 'demo');
  await c.activateWorkflow(wf.id);
  const exec = await c.executeWorkflow(wf.id, { url: 'https://example.com' });

  console.log('Execution:', exec.id);
}

main().catch(console.error);`;

const PYTHON_INSTALL = `pip install synapsedx-sdk

# or with venv:
python -m venv .venv
source .venv/bin/activate
pip install synapsedx-sdk`;

const PYTHON_QUICKSTART = `from synapsedx_sdk import SynapseDXClient

c = SynapseDXClient("http://localhost:8080")

# Login
login = c.login("demo@acme.local")
c.set_token(login["accessToken"])

# Create org, authorize, deploy workflow
c.create_org("acme-2", "ACME 2")
c.authorize(login["user"]["id"], "workflow:Execute", "*")
c.create_workflow_from_template("webhook-to-log", "demo")`;

const PYTHON_CONSTRUCTOR = `SynapseDXClient(base_url, token=None, api_key=None, timeout=15)

# Parameters:
#   base_url  (str)          — gateway URL
#   token     (str | None)   — Bearer JWT
#   api_key   (str | None)   — API key (X-API-Key header)
#   timeout   (int)          — per-request timeout in seconds (default 15)

c.set_token(token)    # set/replace Bearer token
c.set_api_key(key)   # set/replace API key`;

const PYTHON_AUTH = `result = c.login("demo@acme.local", "acme")
# result = {"accessToken": ..., "refreshToken": ..., "user": ...}

c.refresh(refresh_token)     # rotate token
c.logout(refresh_token)       # revoke one session
c.logout_all(refresh_token)  # revoke ALL sessions
c.verify()                   # check current token/key
c.me()                       # current user record`;

const PYTHON_ORGS = `c.list_orgs()                          # all organizations
org = c.create_org("acme-2", "ACME 2")  # create org
accounts = c.list_accounts(org["id"])   # list accounts
account = c.create_account(org["id"], "prod", "Production")
users = c.list_users(org["id"])         # list users
user = c.create_user(org["id"], "alice@acme.local", "Alice")
policies = c.user_policies(user_id)     # effective policies`;

const PYTHON_IAM = `role = c.create_role(account_id, "etl-runner", "Runs ETL workflows")
roles = c.list_roles(account_id)
c.delete_role(role_id)

doc = {
    "Version": "2012-17-10",
    "Statement": [{"Effect": "Allow", "Action": ["workflow:Execute"], "Resource": ["*"]}],
}
policy = c.create_policy(account_id, "wf-exec", doc, "Allow workflow execution")
policies = c.list_policies(account_id)
c.delete_policy(policy_id)

c.attach_policy(role_id, policy_id)
c.assign_role(user_id, role_id)`;

const PYTHON_AUTHZ = `result = c.authorize(user_id, "workflow:Execute", "*", {"team": "etl"})
allowed = result["allowed"]

result = c.simulate([policy_doc], "workflow:Execute", "*")
entries = c.list_audit(20, user_id)`;

const PYTHON_KEYS = `result = c.create_api_key(account_id, "ci-deploy", ["workflow:Execute"])
api_key = result["apiKey"]

c.revoke_api_key(key_id)
info = c.verify_api_key(api_key)
keys = c.list_api_keys(account_id)

sa = c.create_service_account(account_id, "etl-bot", "ETL service account")
sas = c.list_service_accounts(account_id)
result = c.service_account_token(sa_id, ["workflow:Execute"])
sa_token = result["accessToken"]`;

const PYTHON_WORKFLOWS = `wfs = c.list_workflows()
wf = c.get_workflow(id)
new_wf = c.create_workflow_from_template("webhook-to-log", "my-webhook")
custom = c.create_workflow("my-wf", n8n_definition)

c.activate_workflow(id)
c.deactivate_workflow(id)
c.update_workflow(id, name="renamed")
c.delete_workflow(id)
exec_result = c.execute_workflow(id, {"url": "https://example.com/hook"})

templates = c.list_templates()
tpl = c.get_template("webhook-to-log")
keys = c.list_api_keys(account_id)

recent = c.list_executions("limit=10")
execution = c.get_execution(exec_id)`;

const PYTHON_ERRORS = `from synapsedx_sdk import SynapseDXError

try:
    c.authorize(user_id, "workflow:Execute", "*")
except SynapseDXError as e:
    print(f"Error: {e}")  # e.g. "synapsedx 403 /v1/authorize: ..."`;

const PYTHON_EXAMPLE = `from synapsedx_sdk import SynapseDXClient

def main():
    c = SynapseDXClient("http://localhost:8080")

    login = c.login("demo@acme.local")
    c.set_token(login["accessToken"])
    user = login["user"]

    org = c.create_org("acme", "ACME Corp")
    account = c.create_account(org["id"], "prod", "Production")

    role = c.create_role(account["id"], "wf-runner", "Workflow runner")
    policy = c.create_policy(account["id"], "wf-exec", {
        "Version": "2012-17-10",
        "Statement": [{"Effect": "Allow", "Action": ["workflow:Execute"], "Resource": ["*"]}],
    })
    c.attach_policy(role["id"], policy["id"])
    c.assign_role(user["id"], role["id"])

    wf = c.create_workflow_from_template("webhook-to-log", "demo")
    c.activate_workflow(wf["id"])
    exec_result = c.execute_workflow(wf["id"], {"url": "https://example.com"})

    print(f"Execution: {exec_result['id']}")

if __name__ == "__main__":
    main()`;

const GO_INSTALL = `# via monorepo replace directive:
go mod edit -replace github.com/synapsedx/synapsedx-sdk-go=./sdks/sdk-go
go mod tidy

# or from the registry:
go get github.com/synapsedx/synapsedx-sdk-go@latest`;

const GO_QUICKSTART = `import synapsedx "github.com/synapsedx/synapsedx-sdk-go"

c := synapsedx.New("http://localhost:8080")

out, err := c.Login("demo@acme.local", "acme")
if err != nil { panic(err) }
c.SetToken(out["accessToken"].(string))

orgs, err := c.ListOrgs()
if err != nil { panic(err) }`;

const GO_CONSTRUCTOR = `c := synapsedx.New("http://localhost:8080")
// — 15s default timeout

// Custom client (mTLS, tracing, custom timeout):
c := synapsedx.NewWithClient("http://localhost:8080", &http.Client{
    Timeout: 30 * time.Second,
})

c.SetToken(jwt)    // set/replace Bearer token
c.SetAPIKey(key)   // set/replace API key`;

const GO_AUTH = `out, err := c.Login("demo@acme.local", "acme")
// out = map with "accessToken", "refreshToken", "user"

out, err := c.Refresh(refreshToken)   // rotate token
err = c.Logout(refreshToken)         // revoke one session
out, err = c.LogoutAll(refreshToken) // revoke ALL sessions
out, err = c.Verify()                // check current token/key
out, err = c.Me()                    // current user record`;

const GO_ORGS = `orgs, err := c.ListOrgs()
org, err := c.CreateOrg("acme-2", "ACME 2")
accounts, err := c.ListAccounts(orgID)
acct, err := c.CreateAccount(orgID, "prod", "Production")
users, err := c.ListUsers(orgID)
user, err := c.CreateUser(orgID, "alice@acme.local", "Alice")
policies, err := c.UserPolicies(userID)`;

const GO_IAM = `role, err := c.CreateRole(accountID, "etl-runner", "Runs ETL workflows")
roles, err := c.ListRoles(accountID)
err = c.DeleteRole(roleID)

doc := map[string]any{
    "Version": "2012-17-10",
    "Statement": []any{
        map[string]any{
            "Effect":   "Allow",
            "Action":   []string{"workflow:Execute"},
            "Resource": []string{"*"},
        },
    },
}
policy, err := c.CreatePolicy(accountID, "wf-exec", doc, "Allow workflow execution")
policies, err := c.ListPolicies(accountID)
err = c.DeletePolicy(policyID)

err = c.AttachPolicy(roleID, policyID)
err = c.AssignRole(userID, roleID)`;

const GO_AUTHZ = `result, err := c.Authorize(userID, "workflow:Execute", "*", map[string]any{"team": "etl"})
allowed := result["allowed"].(bool)

result, err := c.Simulate([]any{policyDoc}, "workflow:Execute", "*", nil)
entries, err := c.ListAudit(20, userID)`;

const GO_KEYS = `result, err := c.CreateAPIKey(accountID, "ci-deploy", []string{"workflow:Execute"})
apiKey := result["apiKey"].(string)

err = c.RevokeAPIKey(keyID)
info, err := c.VerifyAPIKey(apiKey)
keys, err := c.ListAPIKeys(accountID)

sa, err := c.CreateServiceAccount(accountID, "etl-bot", "ETL service account")
sas, err := c.ListServiceAccounts(accountID)
result, err := c.ServiceAccountToken(saID, []string{"workflow:Execute"})
saToken := result["accessToken"].(string)`;

const GO_WORKFLOWS = `wfs, err := c.ListWorkflows()
wf, err := c.GetWorkflow(id)
newWf, err := c.CreateWorkflowFromTemplate("webhook-to-log", "my-webhook")
custom, err := c.CreateWorkflowRaw("my-wf", n8nDefinition)

err = c.ActivateWorkflow(id)
err = c.DeactivateWorkflow(id)
_, err = c.UpdateWorkflow(id, map[string]any{"name": "renamed"})
err = c.DeleteWorkflow(id)
exec, err := c.ExecuteWorkflow(id, map[string]any{"url": "https://example.com/hook"})

templates, err := c.ListTemplates()
tpl, err := c.GetTemplate("webhook-to-log")
keys, err := c.ListAPIKeys(accountID)

recent, err := c.ListExecutions("limit=10")
execution, err := c.GetExecution(execID)`;

const GO_ERRORS = `result, err := c.Authorize(userID, "workflow:Execute", "*", nil)
if err != nil {
    log.Fatalf("authorize failed: %v", err)
    // e.g. "synapsedx 403 /v1/authorize: ..."
}`;

const GO_EXAMPLE = `package main

import (
    "fmt"
    "log"
    synapsedx "github.com/synapsedx/synapsedx-sdk-go"
)

func main() {
    c := synapsedx.New("http://localhost:8080")

    login, err := c.Login("demo@acme.local", "acme")
    if err != nil { log.Fatal(err) }
    c.SetToken(login["accessToken"].(string))
    user := login["user"].(map[string]any)

    org, err := c.CreateOrg("acme", "ACME Corp")
    if err != nil { log.Fatal(err) }
    acct, err := c.CreateAccount(org["id"].(string), "prod", "Production")
    if err != nil { log.Fatal(err) }

    role, err := c.CreateRole(acct["id"].(string), "wf-runner", "Workflow runner")
    if err != nil { log.Fatal(err) }
    policy, err := c.CreatePolicy(acct["id"].(string), "wf-exec", map[string]any{
        "Version": "2012-17-10",
        "Statement": []any{
            map[string]any{"Effect": "Allow", "Action": []string{"workflow:Execute"}, "Resource": []string{"*"}},
        },
    }, "")
    if err != nil { log.Fatal(err) }
    c.AttachPolicy(role["id"].(string), policy["id"].(string))
    c.AssignRole(user["id"].(string), role["id"].(string))

    wf, err := c.CreateWorkflowFromTemplate("webhook-to-log", "demo")
    if err != nil { log.Fatal(err) }
    c.ActivateWorkflow(wf["id"].(string))
    exec, err := c.ExecuteWorkflow(wf["id"].(string), map[string]any{
        "url": "https://example.com",
    })
    if err != nil { log.Fatal(err) }

    fmt.Println("Execution:", exec["id"])
}`;

const CLI_INSTALL = `# one-line installer (recommended):
curl -fsSL https://synapsedx.sbs/install.sh | sh

# from npm registry:
npm install -g @synapsedx/cli@latest

# run without installing:
npx -y @synapsedx/cli@latest --help

# from source:
node tools/cli/bin/synapsedx.js --help
npm link ./tools/cli   # then: synapsedx ...`;

const CLI_CONFIG = `# Base URL resolution (first match wins):
#   --base <URL> > $SYNAPSEDX_BASE_URL > ~/.synapsedx/config.json > http://localhost:8080

# Auth resolution (first match wins):
#   --token/--apikey > $SYNAPSEDX_TOKEN/$SYNAPSEDX_API_KEY > config file

# Config file: ~/.synapsedx/config.json (0600 permissions)
# Secrets are never printed (config command shows ***)

# Global flags:
#   --base URL    --token T    --apikey K    --json
#   --context k=v (repeatable)    --file path
#   --limit N    --actor ID    --name N    --template T
#   --email E    --org SLUG    --label L`;

const CLI_AUTH = `synapsedx login --email demo@acme.local [--org acme]
synapsedx refresh [refresh-token]
synapsedx logout-all [refresh-token]
synapsedx logout
synapsedx verify
synapsedx use-key <api-key>
synapsedx whoami
synapsedx config`;

const CLI_ORGS = `synapsedx orgs
synapsedx orgs create <slug> [name]

synapsedx accounts [org]
synapsedx accounts create [org] <slug> [name]

synapsedx users [org]
synapsedx users create <org> <email> [name]
synapsedx users policies <user-id>`;

const CLI_IAM = `synapsedx roles <account>
synapsedx roles create <account> <slug>
synapsedx roles delete <role-id>

synapsedx policies <account>
synapsedx policies create <account> <slug> --file policy.json
synapsedx policies delete <policy-id>

synapsedx attach <role-id> <policy-id>
synapsedx assign <user-id> <role-id>`;

const CLI_AUTHZ = `synapsedx authz <user-id> <action> <resource> [--context k=v]
synapsedx sim --file policy.json <action> <resource> [--context k=v]

synapsedx audit [--limit N] [--actor ID]`;

const CLI_KEYS = `synapsedx keys create <account> [--name N]
synapsedx keys revoke <key-id>
synapsedx keys verify <api-key>

synapsedx sa <account>
synapsedx sa create <account> <slug>
synapsedx sa token <sa-id>`;

const CLI_WORKFLOWS = `synapsedx workflows
synapsedx workflows create --template <name> [--name N]
synapsedx workflows create --file definition.json [--name N]
synapsedx workflows get <id>
synapsedx workflows activate <id>
synapsedx workflows deactivate <id>
synapsedx workflows exec <id>

synapsedx templates
synapsedx templates <name>

synapsedx executions
synapsedx executions list [--limit N]
synapsedx executions <id>`;

const CLI_EXAMPLE = `# 1. Login
synapsedx login --email demo@acme.local

# 2. Create org + account
synapsedx orgs create acme "ACME Corp"
synapsedx accounts create prod Production

# 3. Create role + policy
synapsedx roles create acc_abc123 wf-runner
synapsedx policies create acc_abc123 wf-exec --file policy.json
synapsedx attach rol_abc123 pol_abc123
synapsedx assign usr_abc123 rol_abc123

# 4. Deploy + execute workflow
synapsedx workflows create --template webhook-to-log --name demo
synapsedx workflows activate wf_abc123
synapsedx workflows exec wf_abc123

# 5. Check audit log
synapsedx audit --limit 20`;

const SDK_DOCS = {
  JavaScript: [
    { title: 'Install', code: JS_INSTALL },
    { title: 'Quick start', code: JS_QUICKSTART },
    { title: 'Constructor', code: JS_CONSTRUCTOR },
    { title: 'Auth', code: JS_AUTH },
    { title: 'Organizations & Users', code: JS_ORGS },
    { title: 'Roles & Policies', code: JS_IAM },
    { title: 'Authorization & Audit', code: JS_AUTHZ },
    { title: 'API Keys & Service Accounts', code: JS_KEYS },
    { title: 'Workflows, Templates & Executions', code: JS_WORKFLOWS },
    { title: 'Error handling', code: JS_ERRORS },
    { title: 'Full example', code: JS_EXAMPLE },
  ],
  Python: [
    { title: 'Install', code: PYTHON_INSTALL },
    { title: 'Quick start', code: PYTHON_QUICKSTART },
    { title: 'Constructor', code: PYTHON_CONSTRUCTOR },
    { title: 'Auth', code: PYTHON_AUTH },
    { title: 'Organizations & Users', code: PYTHON_ORGS },
    { title: 'Roles & Policies', code: PYTHON_IAM },
    { title: 'Authorization & Audit', code: PYTHON_AUTHZ },
    { title: 'API Keys & Service Accounts', code: PYTHON_KEYS },
    { title: 'Workflows, Templates & Executions', code: PYTHON_WORKFLOWS },
    { title: 'Error handling', code: PYTHON_ERRORS },
    { title: 'Full example', code: PYTHON_EXAMPLE },
  ],
  Go: [
    { title: 'Install', code: GO_INSTALL },
    { title: 'Quick start', code: GO_QUICKSTART },
    { title: 'Client construction', code: GO_CONSTRUCTOR },
    { title: 'Auth', code: GO_AUTH },
    { title: 'Organizations & Users', code: GO_ORGS },
    { title: 'Roles & Policies', code: GO_IAM },
    { title: 'Authorization & Audit', code: GO_AUTHZ },
    { title: 'API Keys & Service Accounts', code: GO_KEYS },
    { title: 'Workflows, Templates & Executions', code: GO_WORKFLOWS },
    { title: 'Error handling', code: GO_ERRORS },
    { title: 'Full example', code: GO_EXAMPLE },
  ],
  CLI: [
    { title: 'Install', code: CLI_INSTALL },
    { title: 'Configuration', code: CLI_CONFIG },
    { title: 'Auth commands', code: CLI_AUTH },
    { title: 'Orgs, Accounts & Users', code: CLI_ORGS },
    { title: 'Roles & Policies', code: CLI_IAM },
    { title: 'Authorization & Audit', code: CLI_AUTHZ },
    { title: 'API Keys & Service Accounts', code: CLI_KEYS },
    { title: 'Workflows & Executions', code: CLI_WORKFLOWS },
    { title: 'Full workflow example', code: CLI_EXAMPLE },
  ],
};

export default function Docs() {
  const [tab, setTab] = useState('Console');
  const sections = SDK_DOCS[tab];

  return (
    <>
      <PageTitle title="Docs" sub="Console, SDK and CLI guides — full documentation" />
      <div className="flex gap-2 mb-4 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-2xl text-sm font-medium ${
              tab === t ? 'bg-gradient-to-b from-main-start to-main-end text-white' : 'bg-white text-normal-text shadow-sm'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'Console' ? (
        <Card>
          <Code data={CONSOLE_DOC} />
        </Card>
      ) : (
        <div className="space-y-4">
          {sections.map((s) => (
            <Card key={s.title}>
              <h3 className="font-semibold text-main-text mb-2">{s.title}</h3>
              <Code data={s.code} />
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
