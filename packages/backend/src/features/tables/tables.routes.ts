import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { tables, rows, tools } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

const TableBody = z.object({
  name: z.string().min(1),
  columns: z.string().default('[]'), // JSON: [{name, type}]
});

export function registerTableRoutes(fastify: FastifyInstance): void {
  const db = getDb();

  fastify.get<{ Params: { agentId: string } }>('/agents/:agentId/tables', async (req) => {
    return db.select().from(tables).where(eq(tables.agentId, req.params.agentId));
  });

  fastify.post<{ Params: { agentId: string } }>('/agents/:agentId/tables', async (req, reply) => {
    const body = TableBody.parse(req.body);
    const id = uuidv4();
    const { agentId } = req.params;
    const tableName = body.name;
    await db.insert(tables).values({ id, agentId, ...body });

    // Auto-create insert and query tools for the new table
    await db.insert(tools).values([
      {
        id: uuidv4(),
        agentId,
        name: `insert_${tableName}`,
        description: `Insert a row into the ${tableName} table`,
        inputSchema: JSON.stringify({ type: 'object', properties: { data: { type: 'object' } } }),
        toolType: 'local',
        code: `const r = await db.insert('${tableName}', input.data || input); return {success:true};`,
      },
      {
        id: uuidv4(),
        agentId,
        name: `query_${tableName}`,
        description: `Query rows from the ${tableName} table with optional filter`,
        inputSchema: JSON.stringify({ type: 'object', properties: { filter: { type: 'object' } } }),
        toolType: 'local',
        code: `return db.select('${tableName}', input.filter);`,
      },
    ]);

    const [table] = await db.select().from(tables).where(eq(tables.id, id));
    return reply.status(201).send(table);
  });

  fastify.delete<{ Params: { agentId: string; tableId: string } }>(
    '/agents/:agentId/tables/:tableId',
    async (req, reply) => {
      await db.delete(tables).where(
        and(eq(tables.agentId, req.params.agentId), eq(tables.id, req.params.tableId)),
      );
      return { success: true };
    },
  );

  // Rows
  fastify.get<{ Params: { tableId: string } }>('/tables/:tableId/rows', async (req) => {
    return db.select().from(rows).where(eq(rows.tableId, req.params.tableId));
  });

  fastify.post<{ Params: { tableId: string } }>('/tables/:tableId/rows', async (req, reply) => {
    const data = req.body as Record<string, unknown>;
    const id = uuidv4();
    await db.insert(rows).values({ id, tableId: req.params.tableId, data: JSON.stringify(data) });
    const [row] = await db.select().from(rows).where(eq(rows.id, id));
    return reply.status(201).send(row);
  });

  fastify.delete<{ Params: { tableId: string; rowId: string } }>(
    '/tables/:tableId/rows/:rowId',
    async (req) => {
      await db.delete(rows).where(
        and(eq(rows.tableId, req.params.tableId), eq(rows.id, req.params.rowId)),
      );
      return { success: true };
    },
  );
}
