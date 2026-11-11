// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * SynapseDX Tier-2 capabilities service.
 *
 * The public boundary is the gateway; this process exposes:
 * - datasets/records/publication/events (Tier-1 Base + LDS + Queue/Stream)
 * - identity adapter (Tier-1 IAM), AI (Tier-1 Inference), jobs (Tier-1 workflow)
 * - audit/usage projections (Tier-1 IAM + Base)
 * - health/readiness with per-dependency status
 */
import express from 'express';
import { ServiceConfig, loadConfig } from './config';
import { correlationMiddleware, corsMiddleware, errorMiddleware, notFoundMiddleware, securityMiddleware } from './http';
import { registerAiRoutes } from './routes/ai';
import { registerApprovalRoutes } from './routes/approvals';
import { registerAuditRoutes } from './routes/audit';
import { registerAuthRoutes } from './routes/auth';
import { registerDatasetRoutes } from './routes/datasets';
import { registerEventRoutes } from './routes/events';
import { registerHealthRoutes, registerCapabilityAdvertisement } from './routes/health';
import { registerJobRoutes } from './routes/jobs';
import { registerManagementRoutes } from './routes/management';
import { registerRecordRoutes } from './routes/records';
import { registerFileRoutes } from './routes/files';
import { registerGeoRoutes } from './routes/geo';
import { registerNotificationRoutes } from './routes/notifications';
import { registerCollaborationRoutes } from './routes/collaboration';
import { registerPeopleProcessRoutes } from './routes/people-process';
import { registerDataInsightRoutes } from './routes/data-insights';
import { registerIntelligenceRoutes } from './routes/intelligence';
import { registerKnowledgeRoutes } from './routes/knowledge';
import { registerHazardRoutes, startKttvScheduler } from './routes/hazards';
import { registerWarehouseRoutes } from './routes/warehouse';

export function createServer(config: ServiceConfig = loadConfig()): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware(config));
  app.use(securityMiddleware());
  app.use(correlationMiddleware());
  const jsonParser = express.json({ limit: '2mb' });
  app.use((req, res, next) => {
    // File content is raw bytes for every content type (GeoJSON/CSV included);
    // the route installs express.raw itself.
    if (req.method === 'PUT' && /^\/v1\/capabilities\/files\/[^/]+\/content$/.test(req.path)) {
      next();
      return;
    }
    jsonParser(req, res, next);
  });

  registerCapabilityAdvertisement(app, config);
  registerHealthRoutes(app, config);
  registerAuthRoutes(app, config);
  registerManagementRoutes(app, config);
  registerApprovalRoutes(app, config);
  registerDatasetRoutes(app, config);
  registerRecordRoutes(app, config);
  registerEventRoutes(app, config);
  registerAiRoutes(app, config);
  registerJobRoutes(app, config);
  registerAuditRoutes(app, config);
  registerFileRoutes(app, config);
  registerNotificationRoutes(app, config);
  registerGeoRoutes(app, config);
  registerCollaborationRoutes(app, config);
  registerPeopleProcessRoutes(app, config);
  registerDataInsightRoutes(app, config);
  registerIntelligenceRoutes(app, config);
  registerKnowledgeRoutes(app, config);
  registerHazardRoutes(app, config);
  registerWarehouseRoutes(app, config);

  app.use(notFoundMiddleware());
  app.use(errorMiddleware());
  return app;
}

if (require.main === module) {
  const config = loadConfig();
  const app = createServer(config);
  app.listen(config.port, () => {
    console.log(`[synapsedx] Tier-2 capabilities listening on :${config.port}; Tier-1=${config.tier1BaseUrl}; auth=${config.authMode}`);
    startKttvScheduler(config);
  });
}
