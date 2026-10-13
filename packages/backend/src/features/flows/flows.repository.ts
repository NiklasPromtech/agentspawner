/**
 * flows.repository.ts
 * Low-level DB access for the flows, flowRuns, agents, and tools tables
 * as needed by the flows feature.
 */
import { eq, and, ne, desc, gt, inArray } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { flows, flowRuns, tools, agents } from '../../db/schema.js';
import { v4 as uuidv4 } from 'uuid';

export type FlowRow = typeof flows.$inferSelect;
export type FlowInsert = typeof flows.$inferInsert;
export type FlowRunRow = typeof flowRuns.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type ToolRow = typeof tools.$inferSelect;

// ── Flow queries ──────────────────────────────────────────────────────────────

export async function findFlows(agentId: string): Promise<FlowRow[]> {
  const db = getDb();
  return db.select().from(flows).where(eq(flows.agentId, agentId));
}

export async function findFlowById(agentId: string, flowId: string): Promise<FlowRow | undefined> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, flowId), eq(flows.agentId, agentId)));
  return row;
}

/** Looks up a flow by its ID only — no agentId filter.
 *  Used by the step debugger endpoint which only knows the flowId. */
export async function findFlowByIdOnly(flowId: string): Promise<FlowRow | undefined> {
  const db = getDb();
  const [row] = await db.select().from(flows).where(eq(flows.id, flowId)).limit(1);
  return row;
}

export async function findFlowByName(
  agentId: string,
  name: string,
  excludeId?: string,
): Promise<FlowRow | undefined> {
  const db = getDb();
  const condition = excludeId
    ? and(eq(flows.agentId, agentId), eq(flows.name, name), ne(flows.id, excludeId))
    : and(eq(flows.agentId, agentId), eq(flows.name, name));
  const [row] = await db.select().from(flows).where(condition);
  return row;
}

export async function insertFlow(values: FlowInsert): Promise<FlowRow> {
  const db = getDb();
  const id = values.id ?? uuidv4();
  await db.insert(flows).values({ ...values, id });
  const [row] = await db.select().from(flows).where(eq(flows.id, id));
  return row;
}

export async function updateFlowById(
  flowId: string,
  update: Partial<FlowInsert>,
): Promise<FlowRow> {
  const db = getDb();
  await db.update(flows).set(update).where(eq(flows.id, flowId));
  const [row] = await db.select().from(flows).where(eq(flows.id, flowId));
  return row;
}

export async function deleteFlowById(flowId: string): Promise<void> {
  const db = getDb();
  await db.delete(flows).where(eq(flows.id, flowId));
}

// ── Flow runs queries ─────────────────────────────────────────────────────────

export async function findFlowRuns(
  agentId: string,
  limit: number,
  flowType?: string,
): Promise<FlowRunRow[]> {
  const db = getDb();

  if (flowType) {
    // Resolve flowIds for this agent that match the requested flowType
    const matchingFlows = await db
      .select({ id: flows.id })
      .from(flows)
      .where(and(eq(flows.agentId, agentId), eq(flows.flowType, flowType)));

    if (matchingFlows.length === 0) return [];

    const ids = matchingFlows.map((f) => f.id);
    return db
      .select()
      .from(flowRuns)
      .where(and(eq(flowRuns.agentId, agentId), inArray(flowRuns.flowId, ids)))
      .orderBy(desc(flowRuns.createdAt))
      .limit(limit);
  }

  return db
    .select()
    .from(flowRuns)
    .where(eq(flowRuns.agentId, agentId))
    .orderBy(desc(flowRuns.createdAt))
    .limit(limit);
}

// ── Tool / agent lookups used by flows business logic ─────────────────────────

export async function findToolByName(agentId: string, name: string): Promise<ToolRow | undefined> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.agentId, agentId), eq(tools.name, name)));
  return row;
}

export async function findAgentById(agentId: string): Promise<AgentRow | undefined> {
  const db = getDb();
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
  return row;
}

// Re-export the table reference so consumers don't need to import db/schema directly
export { flows, flowRuns, tools, agents };
