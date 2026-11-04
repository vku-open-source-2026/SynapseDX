// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Per-dependency health and readiness projection.
 *
 * Tier-3 needs to distinguish "no data" from "cannot read data"; the response
 * names each downstream dependency with status, latency and a public error
 * code. Readiness fails with 503 when a critical dependency is unavailable.
 */
import { Express } from 'express';
import { SynapseOneClient, SynapseOneError } from '@synapseone/sdk';
import { ServiceConfig } from '../config';
import { handler } from '../http';
import { serviceClient } from '../platform';

export type DependencyStatus = 'ok' | 'degraded' | 'down';

export interface DependencyHealth {
  name: string;
  status: DependencyStatus;
  latency_ms: number;
  critical: boolean;
  error?: string;
}

interface Probe {
  name: string;
  critical: boolean;
  run: (client: SynapseOneClient) => Promise<void>;
}

function safeCode(error: unknown): string {
  if (error instanceof SynapseOneError) {
    if (error.status === 401 || error.status === 403) return 'credential_rejected';
    if (error.status === 404) return 'not_created';
    return `upstream_${error.status || 'network'}`;
  }
  if ((error as Error)?.name === 'AbortError') return 'timeout';
  return 'unreachable';
}

async function probe(entry: Probe, client: SynapseOneClient, timeoutMs: number): Promise<DependencyHealth> {
  const started = Date.now();
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })), timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([entry.run(client), timeout]);
    return { name: entry.name, status: 'ok', latency_ms: Date.now() - started, critical: entry.critical };
  } catch (error) {
    const code = safeCode(error);
    // A lazily created queue/topic is not a failure for readiness.
    if (!entry.critical && code === 'not_created') {
      return { name: entry.name, status: 'ok', latency_ms: Date.now() - started, critical: entry.critical };
    }
    return {
      name: entry.name,
      status: entry.critical ? 'down' : 'degraded',
      latency_ms: Date.now() - started,
      critical: entry.critical,
      error: code,
    };
  }
}

function probesFor(config: ServiceConfig): Probe[] {
  return [
    {
      name: 'base',
      critical: true,
      run: async (client) => { await client.base.queryDocuments('synapsedx_capability_datasets', { limit: 1 }); },
    },
    { name: 'lds', critical: true, run: async (client) => { await client.lds.licenses(); } },
    {
      name: 'queue',
      critical: true,
      run: async (client) => {
        try {
          await client.queue.getQueue(config.eventsQueue);
        } catch (error) {
          // The queue is created lazily on the first event.
          if (!(error instanceof SynapseOneError && error.status === 404)) throw error;
        }
      },
    },
    { name: 'stream', critical: false, run: async (client) => { await client.stream.listTopics(); } },
    { name: 'iam', critical: false, run: async (client) => { await client.iam.verify(); } },
    { name: 'workflow', critical: false, run: async (client) => { await client.workflow.listWorkflows(); } },
    { name: 'faststore', critical: false, run: async (client) => { await client.faststore.stats(); } },
    { name: 'storage', critical: false, run: async (client) => { await client.storage.listObjects({ limit: 1 }); } },
    { name: 'notifications', critical: false, run: async (client) => { await client.notifications.list({ limit: 1 }); } },
  ];
}


export interface HealthReport {
  status: DependencyStatus;
  service: string;
  tier: number;
  version: string;
  dependencies: DependencyHealth[];
  credentials: { serviceCredential: boolean; callerVerification: string };
  time: string;
}

export async function collectHealth(config: ServiceConfig): Promise<HealthReport> {
  const client = serviceClient(config, Math.min(config.requestTimeoutMs, 5000));
  const dependencies = await Promise.all(probesFor(config).map((entry) => probe(entry, client, 3000)));
  const credentials = {
    serviceCredential: config.hasServiceCredential,
    callerVerification: 'tier1-iam',
  };
  const criticalDown = dependencies.some((dep) => dep.critical && dep.status === 'down');
  const degraded = dependencies.some((dep) => dep.status === 'degraded') || !config.hasServiceCredential;
  const status: DependencyStatus = criticalDown ? 'down' : degraded ? 'degraded' : 'ok';
  return {
    status,
    service: 'synapsedx-capabilities',
    tier: 2,
    version: '0.3.0',
    dependencies,
    credentials,
    time: new Date().toISOString(),
  };
}

export function registerHealthRoutes(app: Express, config: ServiceConfig): void {
  const report = async (_req: import('express').Request, res: import('express').Response) => {
    const health = await collectHealth(config);
    res.setHeader('cache-control', 'no-store');
    res.json(health);
  };

  app.get('/v1/capabilities/health', handler(report));
  app.get('/health', handler(report));

  const ready = async (_req: import('express').Request, res: import('express').Response) => {
    const health = await collectHealth(config);
    const criticalDown = health.dependencies.some((dep) => dep.critical && dep.status === 'down');
    const body = { ...health, status: criticalDown ? 'down' : health.status === 'down' ? 'degraded' : health.status };
    res.setHeader('cache-control', 'no-store');
    res.status(criticalDown ? 503 : 200).json(body);
  };

  app.get('/v1/capabilities/ready', handler(ready));
  app.get('/ready', handler(ready));
}

export function registerCapabilityAdvertisement(app: Express, config: ServiceConfig): void {
  app.get('/v1/capabilities', (_req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.json({
      service: 'synapsedx-capabilities',
      tier: 2,
      version: '0.3.0',
      auth: {
        mode: config.authMode,
        callers: ['Authorization: Bearer', 'X-API-Key'],
        verifiedBy: 'https://api.synapseone.space/v1/auth/verify',
      },
      capabilities: [
        { name: 'datasets', status: 'available' },
        { name: 'records', status: 'available' },
        { name: 'publication', status: 'available' },
        { name: 'events', status: 'available', transport: ['queue', 'stream'], delivery: 'at-least-once' },
        { name: 'identity', status: 'available', capabilities: ['register', 'password-login', 'password-change', 'password-reset', 'email-verify', 'sessions', 'refresh', 'logout', 'oidc', 'delegated-exchange'] },
        { name: 'ai', status: 'available' },
        { name: 'jobs', status: 'available', backend: 'synapseone-workflow', executors: ['workflow', 'runner'] },
        { name: 'audit', status: 'available' },
        { name: 'usage', status: 'available' },
        { name: 'files', status: 'available', backend: 'synapseone-storage' },
        { name: 'notifications', status: 'available', backend: 'synapseone-notifications' },
        { name: 'geo', status: config.geocoder ? 'available' : 'unconfigured', provider: config.geocoder?.provider, dependency: config.geocoder ? undefined : 'SYNAPSEDX_GEOCODER_BASE_URL' },
      ],
      cors: { origins: config.corsOrigins },
      dependencies: { tier1: config.tier1BaseUrl },
    });
  });
}
