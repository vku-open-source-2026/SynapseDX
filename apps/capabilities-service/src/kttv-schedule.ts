// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * KTTV crawler scheduling owns no local timer.
 *
 * Tier 2 provisions one active SynapseFlow workflow in Tier 1. The workflow's
 * cron node fires at the configured interval and calls the Tier-2 trigger
 * endpoint through the public HTTPS boundary. Tier-2 keeps only the crawler
 * implementation; Tier-1 owns the schedule and execution history.
 */
import { ServiceConfig } from './config';
import { serviceClient } from './platform';

export const KTTV_WORKFLOW_NAME = 'synapsedx-kttv-crawler';
export const KTTV_CREDENTIAL_NAME = 'synapsedx-kttv-scheduler';
export const KTTV_TRIGGER_PATH = '/v1/capabilities/crawlers/kttv/trigger';

interface WorkflowRecord {
  id: string;
  name?: string;
  active?: boolean;
}

function unwrapWorkflows(payload: unknown): WorkflowRecord[] {
  const body = payload as any;
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.workflows)) return body.workflows;
  return [];
}

function unwrapCredentials(payload: unknown): Array<{ id: string; name?: string; kind?: string }> {
  const body = payload as any;
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

export function kttvWorkflowDefinition(config: ServiceConfig, credentialId: string): Record<string, unknown> {
  const every = Math.max(60, Math.min(config.kttvScheduleEverySeconds, 86400));
  return {
    nodes: [
      {
        id: 'kttv-schedule',
        name: 'Schedule',
        type: 'n8n-nodes-base.cron',
        typeVersion: 1,
        position: [200, 300],
        parameters: {
          rule: { interval: [{ field: 'seconds', secondsInterval: every }] },
          timezone: 'UTC',
        },
      },
      {
        id: 'kttv-trigger',
        name: 'Trigger KTTV crawler',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [440, 300],
        parameters: {
          url: `${config.publicUrl}${KTTV_TRIGGER_PATH}`,
          method: 'POST',
          timeoutMs: 30000,
          retry: { attempts: 2, delayMs: 2000 },
          auth: {
            credentialId,
            ...(config.serviceApiKey ? { header: 'x-api-key' } : {}),
          },
        },
      },
    ],
    connections: {
      Schedule: { main: [[{ node: 'Trigger KTTV crawler', type: 'main', index: 0 }]] },
    },
    settings: { timeoutMs: 60000 },
  };
}

/** Provision or repair the Tier-1 schedule. Safe to call on every start. */
export async function ensureKttvSchedule(config: ServiceConfig): Promise<{ workflowId: string; credentialId: string } | null> {
  if (!config.kttvScheduleEnabled) return null;
  if (!config.serviceApiKey && !config.serviceToken) {
    console.warn('[kttv] schedule disabled: no Tier-1 service credential is configured');
    return null;
  }
  const client = serviceClient(config);
  const verify = await client.iam.verify() as any;
  const accountId = String(verify?.account_id || '').trim();
  if (!accountId) throw new Error('Tier-1 credential verification did not return account_id');

  const credentials = unwrapCredentials(await client.workflow.listCredentials(accountId));
  let credential = credentials.find((item) => item.name === KTTV_CREDENTIAL_NAME);
  const kind = config.serviceApiKey ? 'api-key' : 'bearer';
  const secret = config.serviceApiKey || config.serviceToken as string;
  if (credential && credential.kind && credential.kind !== kind) {
    await client.workflow.deleteCredential(credential.id);
    credential = undefined;
  }
  if (!credential) {
    credential = await client.workflow.createCredential({
      accountId,
      name: KTTV_CREDENTIAL_NAME,
      kind,
      secret,
    }) as { id: string; name?: string };
  } else {
    await client.workflow.rotateCredential(credential.id, secret);
  }

  const definition = kttvWorkflowDefinition(config, credential.id);
  const workflows = unwrapWorkflows(await client.workflow.listWorkflows());
  let workflow = workflows.find((item) => item.name === KTTV_WORKFLOW_NAME);
  if (!workflow) {
    workflow = await client.workflow.createWorkflow(KTTV_WORKFLOW_NAME, definition) as WorkflowRecord;
  } else {
    await client.workflow.updateWorkflow(workflow.id, { definition });
  }
  if (!workflow?.id) throw new Error('Tier-1 did not return a workflow id');
  await client.workflow.activateWorkflow(workflow.id);
  console.log(`[kttv] SynapseFlow schedule active: workflow=${workflow.id} every=${config.kttvScheduleEverySeconds}s`);
  return { workflowId: workflow.id, credentialId: credential.id };
}
