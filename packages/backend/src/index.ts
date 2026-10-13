import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { getConfig } from './config.js';
import { getDb } from './db/index.js';
import { runs } from './db/schema.js';
import { inArray } from 'drizzle-orm';
// ── Feature routes ────────────────────────────────────────────────────────────
import { registerAgentRoutes } from './features/agents/agents.routes.js';
import { registerSetupRoutes } from './features/agents/setup.routes.js';
import { registerFlowRoutes } from './features/flows/flows.routes.js';
import { registerFlowGenerateRoute } from './features/flows/flows-generate.routes.js';
import { registerRunRoutes } from './features/runs/runs.routes.js';
import { registerActionLogRoutes } from './features/runs/action-log.routes.js';
import { registerReviewRoutes } from './features/runs/reviews.routes.js';
import { registerExplainRoutes } from './features/runs/explain.routes.js';
import { registerFlowMasterRoutes } from './features/flow-master/flow-master.routes.js';
import { registerToolRoutes } from './features/tools/tools.routes.js';
import { registerApiToolRoutes } from './features/tools/api-tools.routes.js';
import { registerApiToolDiscoveryRoute } from './features/tools/api-tool-discovery.routes.js';
import { registerGenerateToolRoute } from './features/tools/generate-tool.routes.js';
import { registerTableRoutes } from './features/tables/tables.routes.js';
import { registerScheduleRoutes } from './features/schedules/schedules.routes.js';
import { registerGoalsRoutes } from './features/goals/goals.routes.js';
import { registerContactsRoutes } from './features/contacts/contacts.routes.js';
import { registerAnalyticsRoutes } from './features/analytics/analytics.routes.js';
import { registerMemoryRoutes } from './features/memory/memory.routes.js';
import { registerRecordingRoutes } from './features/recording/recording.routes.js';
// registerActionsRoutes removed — pendingActions routes deleted (OPERATION CONVERGENCE Task 2)
import { registerHealthRoute } from './routes/health.js';
import { registerWebSocketRoute } from './websocket/server.js';
import { reloadSchedules } from './scheduler/index.js';
import { reloadTelegramPollers } from './telegram/index.js';
import { provisionMissingTools } from './orchestrator/provision-tools.js';
import { logger } from './lib/logger.js';
// OPERATION SCREENSHOT REFS — serve persisted screenshots as static files
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { SCREENSHOTS_DIR, ensureScreenshotDir } from './lib/screenshots.js';

const fastify = Fastify({ logger: { level: 'info' } });

await fastify.register(cors, {
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

await fastify.register(fastifyWebSocket);

// Global error handler — converts ZodError to 400
fastify.setErrorHandler((error, _req, reply) => {
  if (error instanceof ZodError) {
    const message = error.errors.map((e) => `${e.path.join('.') || 'body'}: ${e.message}`).join('; ');
    return reply.status(400).send({ error: message });
  }
  fastify.log.error(error);
  const msg = error instanceof Error ? error.message : 'Internal Server Error';
  return reply.status(500).send({ error: msg });
});

// OPERATION SCREENSHOT REFS — serve screenshots at GET /screenshots/:filename
ensureScreenshotDir();
fastify.get('/screenshots/:filename', async (req, reply) => {
  const { filename } = req.params as { filename: string };
  // Prevent path traversal — only allow simple uuid.png filenames
  if (!/^[a-f0-9\-]{36}\.png$/.test(filename)) {
    return reply.status(400).send({ error: 'Invalid filename' });
  }
  const filepath = join(SCREENSHOTS_DIR, filename);
  if (!existsSync(filepath)) {
    return reply.status(404).send({ error: 'Screenshot not found' });
  }
  const data = readFileSync(filepath);
  return reply.header('Content-Type', 'image/png').send(data);
});

// Register all routes
registerHealthRoute(fastify);
registerWebSocketRoute(fastify);
registerAgentRoutes(fastify);
registerToolRoutes(fastify);
registerRunRoutes(fastify);
registerTableRoutes(fastify);
registerScheduleRoutes(fastify);
registerFlowGenerateRoute(fastify);
registerFlowRoutes(fastify);
registerGenerateToolRoute(fastify);
registerMemoryRoutes(fastify);
registerSetupRoutes(fastify);
registerRecordingRoutes(fastify);
registerGoalsRoutes(fastify);
// registerActionsRoutes removed — OPERATION CONVERGENCE Task 2
registerAnalyticsRoutes(fastify);
registerApiToolRoutes(fastify);
registerApiToolDiscoveryRoute(fastify);
registerActionLogRoutes(fastify);
registerContactsRoutes(fastify);
registerReviewRoutes(fastify);
registerExplainRoutes(fastify);
registerFlowMasterRoutes(fastify);

// Initialize DB (creates file if not exists)
const db = getDb();

// Mark any orphaned running/pending runs as stopped.
// Runs can't survive a server restart — their in-memory orchestrators are gone.
// Without this, they stay stuck as 'running' in the DB forever.
{
  const orphaned = await db.select({ id: runs.id }).from(runs)
    .where(inArray(runs.status, ['running', 'pending']));
  if (orphaned.length > 0) {
    const ids = orphaned.map((r) => r.id);
    await db.update(runs)
      .set({ status: 'stopped', updatedAt: new Date().toISOString() })
      .where(inArray(runs.id, ids));
    logger.info({ count: ids.length }, 'Startup: marked orphaned runs as stopped');
  }
}

// Retroactively provision any missing default tools for existing agents
await provisionMissingTools();

// Load schedules
await reloadSchedules();

// Start Telegram polling for agents with bot tokens
await reloadTelegramPollers();

const { port } = getConfig();
await fastify.listen({ port, host: '0.0.0.0' });
logger.info({ port }, `AgentSpawner backend running on http://localhost:${port}`);

// Graceful shutdown on SIGTERM — mark all in-flight runs as stopped, then close
process.once('SIGTERM', async () => {
  logger.info('Shutdown: SIGTERM received — starting graceful shutdown');
  try {
    const db = getDb();
    const orphaned = await db.select({ id: runs.id }).from(runs)
      .where(inArray(runs.status, ['running', 'pending']));
    if (orphaned.length > 0) {
      const ids = orphaned.map((r) => r.id);
      await db.update(runs)
        .set({ status: 'stopped', updatedAt: new Date().toISOString() })
        .where(inArray(runs.id, ids));
      logger.info({ count: ids.length }, 'Shutdown: marked runs as stopped');
    }
  } catch (err) {
    logger.error({ err }, 'Shutdown: failed to stop runs');
  }
  await fastify.close();
  logger.info('Shutdown: server closed');
  process.exit(0);
});
