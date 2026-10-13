import cron from 'node-cron';
import { getDb } from '../db/index.js';
import { schedules, runs, flows } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { runOrchestrator } from '../orchestrator/index.js';
import { runAutonomousOrchestrator } from '../orchestrator/autonomous.js';
import { runFlow } from '../orchestrator/flow-runner.js';
import { emitSseEvent } from '../features/runs/runs.routes.js';
import { logger } from '../lib/logger.js';

const activeTasks = new Map<string, cron.ScheduledTask>();

export async function reloadSchedules(): Promise<void> {
  // Stop all existing tasks
  for (const [, task] of activeTasks) {
    task.stop();
  }
  activeTasks.clear();

  const db = getDb();
  const allSchedules = await db.select().from(schedules).where(eq(schedules.enabled, true));

  for (const schedule of allSchedules) {
    if (!cron.validate(schedule.cron)) {
      logger.warn({ scheduleId: schedule.id, cron: schedule.cron }, 'Scheduler: invalid cron expression');
      continue;
    }

    const task = cron.schedule(
      schedule.cron,
      async () => {
        logger.info({ scheduleId: schedule.id, agentId: schedule.agentId }, 'Scheduler: firing schedule');

        // Update lastRunAt
        await db
          .update(schedules)
          .set({ lastRunAt: new Date().toISOString() })
          .where(eq(schedules.id, schedule.id));

        if (schedule.flowId) {
          // Flow mode: run the flow directly without creating an orchestrator run
          const [flow] = await db.select().from(flows).where(eq(flows.id, schedule.flowId));
          if (!flow) {
            logger.warn({ scheduleId: schedule.id, flowId: schedule.flowId }, 'Scheduler: flow not found for schedule');
            return;
          }
          let flowInput: Record<string, unknown> = {};
          try { flowInput = JSON.parse(schedule.input) as Record<string, unknown>; } catch { /* use empty */ }
          runFlow(flow, flowInput, schedule.agentId).catch((err) => {
            logger.error({ err, scheduleId: schedule.id, agentId: schedule.agentId }, 'Scheduler: flow run error');
          });
        } else if (schedule.input.startsWith('__wake_up__')) {
          // Autonomous mode: the agent wakes up and manages itself using Haiku.
          // Budget is optionally encoded as "__wake_up__:$1/hr"
          const budgetMatch = schedule.input.match(/\$([0-9.]+)\/hr/);
          const budgetUsdPerHour = budgetMatch ? parseFloat(budgetMatch[1]!) : 0;

          const runId = uuidv4();
          await db.insert(runs).values({
            id: runId,
            agentId: schedule.agentId,
            status: 'pending',
            trigger: 'autonomous',
            input: schedule.input,
          });

          const emitter = (event: Parameters<typeof emitSseEvent>[1]) =>
            emitSseEvent(runId, event);
          runAutonomousOrchestrator(runId, schedule.agentId, emitter, budgetUsdPerHour).catch((err) => {
            logger.error({ err, scheduleId: schedule.id, agentId: schedule.agentId }, 'Scheduler: autonomous run error');
          });
        } else {
          // Agent chat mode: create a run and run the orchestrator
          const runId = uuidv4();
          await db.insert(runs).values({
            id: runId,
            agentId: schedule.agentId,
            status: 'pending',
            trigger: 'schedule',
            input: schedule.input,
          });

          const emitter = (event: Parameters<typeof emitSseEvent>[1]) =>
            emitSseEvent(runId, event);
          runOrchestrator(runId, schedule.agentId, schedule.input, emitter).catch((err) => {
            logger.error({ err, scheduleId: schedule.id, agentId: schedule.agentId }, 'Scheduler: orchestrator run error');
          });
        }
      },
      {
        timezone: schedule.timezone,
      },
    );

    activeTasks.set(schedule.id, task);
  }

  logger.info({ count: activeTasks.size }, 'Scheduler: loaded active schedules');
}
