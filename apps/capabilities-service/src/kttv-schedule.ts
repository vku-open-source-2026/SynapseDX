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

export interface KttvScheduleState {
  enabled: boolean;
  provisioned: boolean;
  workflowId?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  nextRetryAt?: string;
  error?: string;
}

let scheduleState: KttvScheduleState = { enabled: false, provisioned: false };
let retryTimer: NodeJS.Timeout | undefined;
let retryAttempt = 0;

export function kttvScheduleState(): KttvScheduleState {
  return { ...scheduleState };
}

/** Test-only: seed the provisioner state without contacting Tier-1. */
export function setKttvScheduleStateForTests(state: Partial<KttvScheduleState>): void {
  scheduleState = { ...scheduleState, ...state };
}

/** Test-only: clear the retry timer and state. */
export function resetKttvScheduleStateForTests(): void {
  scheduleState = { enabled: false, provisioned: false };
  retryAttempt = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
}

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
            // Credential-backed HTTP nodes may only send the secret to an
            // explicitly declared exact origin.
            allowedOrigins: [new URL(config.publicUrl).origin],
          },
        },
      },
    ],
    connections: {
      Schedule: { main: [[{ node: 'Trigger KTTV crawler', type: 'main', index: 0 }]] },
    },
    // Run the short crawler trigger on the Tier-1 workflow service itself.
    // Queue mode would require a healthy platform runner; when that pool is
    // unavailable the cron queues forever and the hazard feed goes stale.
    settings: { timeoutMs: 60000, execution: { mode: 'inline' } },
  };
}

/** Provision or repair the Tier-1 schedule. Safe to call on every start. */
export async function ensureKttvSchedule(config: ServiceConfig): Promise<{ workflowId: string; credentialId: string } | null> {
  scheduleState = {
    ...scheduleState,
    enabled: config.kttvScheduleEnabled,
    lastAttemptAt: new Date().toISOString(),
  };
  if (!config.kttvScheduleEnabled) {
    scheduleState = { enabled: false, provisioned: false };
    return null;
  }
  if (!config.serviceApiKey && !config.serviceToken) {
    scheduleState = {
      ...scheduleState,
      provisioned: false,
      error: 'missing_service_credential',
    };
    console.warn('[kttv] schedule not provisioned: no Tier-1 service credential is configured');
    return null;
  }
  try {
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
    // Tier-1 ignores a `settings` key inside `definition`; it must be sent as the
    // top-level workflow settings for the cron loop to choose inline execution.
    const settings = { timeoutMs: 60000, execution: { mode: 'inline' } };
    const workflows = unwrapWorkflows(await client.workflow.listWorkflows());
    let workflow = workflows.find((item) => item.name === KTTV_WORKFLOW_NAME);
    if (!workflow) {
      workflow = await client.workflow.createWorkflow(KTTV_WORKFLOW_NAME, definition, settings) as WorkflowRecord;
    } else {
      await client.workflow.updateWorkflow(workflow.id, { definition, settings });
    }
    if (!workflow?.id) throw new Error('Tier-1 did not return a workflow id');
    await client.workflow.activateWorkflow(workflow.id);
    scheduleState = {
      enabled: true,
      provisioned: true,
      workflowId: workflow.id,
      lastAttemptAt: scheduleState.lastAttemptAt,
      lastSuccessAt: new Date().toISOString(),
    };
    retryAttempt = 0;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    console.log(`[kttv] SynapseFlow schedule active: workflow=${workflow.id} every=${config.kttvScheduleEverySeconds}s`);
    return { workflowId: workflow.id, credentialId: credential.id };
  } catch (error) {
    scheduleState = {
      ...scheduleState,
      provisioned: false,
      error: (error as Error)?.message || 'provisioning failed',
    };
    throw error;
  }
}

function scheduleRetry(config: ServiceConfig, attempt: () => Promise<void>): void {
  const delayMs = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(retryAttempt, 6));
  retryAttempt += 1;
  scheduleState = {
    ...scheduleState,
    nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
  };
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void attempt();
  }, delayMs);
  retryTimer.unref?.();
  console.warn(`[kttv] schedule provisioning retry in ${Math.round(delayMs / 1000)}s`);
}

/**
 * Start schedule provisioning and keep retrying transient failures with
 * exponential backoff. Readiness reflects the exported state; a failure is no
 * longer only a log line at startup.
 */
export function startKttvScheduleProvisioning(config: ServiceConfig): void {
  if (!config.kttvScheduleEnabled) {
    scheduleState = { enabled: false, provisioned: false };
    return;
  }
  const attempt = async (): Promise<void> => {
    try {
      const result = await ensureKttvSchedule(config);
      if (config.kttvScheduleEnabled && !result) scheduleRetry(config, attempt);
    } catch (error) {
      console.error('[kttv] failed to provision the SynapseFlow schedule:', (error as Error)?.message || error);
      scheduleRetry(config, attempt);
    }
  };
  void attempt();
}
