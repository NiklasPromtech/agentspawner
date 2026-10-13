/**
 * agents.repository.ts
 * Low-level DB access for the agents table.
 * All SQL/Drizzle calls for agents live here.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { agents, tools } from '../../db/schema.js';

export type AgentRow = typeof agents.$inferSelect;
export type AgentInsert = typeof agents.$inferInsert;

export async function findAllAgents(): Promise<AgentRow[]> {
  const db = getDb();
  return db.select().from(agents);
}

export async function findAgentById(id: string): Promise<AgentRow | undefined> {
  const db = getDb();
  const [row] = await db.select().from(agents).where(eq(agents.id, id));
  return row;
}

export async function insertAgent(values: AgentInsert): Promise<AgentRow> {
  const db = getDb();
  await db.insert(agents).values(values);
  const [row] = await db.select().from(agents).where(eq(agents.id, values.id as string));
  return row;
}

export async function updateAgent(
  id: string,
  update: Partial<AgentInsert>,
): Promise<AgentRow> {
  const db = getDb();
  await db.update(agents).set(update).where(eq(agents.id, id));
  const [row] = await db.select().from(agents).where(eq(agents.id, id));
  return row;
}

export async function deleteAgent(id: string): Promise<void> {
  const db = getDb();
  await db.delete(agents).where(eq(agents.id, id));
}

/** Insert a single tool row (used for auto-provisioning on agent creation). */
export async function insertTool(values: typeof tools.$inferInsert): Promise<void> {
  const db = getDb();
  await db.insert(tools).values(values);
}
