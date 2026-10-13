import { getDb } from '../../db/index.js';
import { tables, rows } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export async function runLocalTool(
  code: string,
  input: Record<string, unknown>,
  agentId: string,
): Promise<string> {
  const db = getDb();

  // Provide a restricted DB proxy for the tool code
  const dbProxy = {
    async select(tableName: string, filter?: Record<string, unknown>) {
      const tableRow = await db
        .select()
        .from(tables)
        .where(eq(tables.name, tableName))
        .then((r) => r.find((t) => t.agentId === agentId));
      if (!tableRow) return [];
      const allRows = await db.select().from(rows).where(eq(rows.tableId, tableRow.id));
      let result = allRows.map((r) => JSON.parse(r.data));
      if (filter) {
        result = result.filter((row) =>
          Object.entries(filter).every(([k, v]) => row[k] === v),
        );
      }
      return result;
    },
    async insert(tableName: string, data: Record<string, unknown>) {
      const tableRow = await db
        .select()
        .from(tables)
        .where(eq(tables.name, tableName))
        .then((r) => r.find((t) => t.agentId === agentId));
      if (!tableRow) throw new Error(`Table "${tableName}" not found`);
      await db.insert(rows).values({
        id: uuidv4(),
        tableId: tableRow.id,
        data: JSON.stringify(data),
      });
      return { success: true };
    },
    async deleteRows(tableName: string, filter: Record<string, unknown>) {
      const tableRow = await db
        .select()
        .from(tables)
        .where(eq(tables.name, tableName))
        .then((r) => r.find((t) => t.agentId === agentId));
      if (!tableRow) throw new Error(`Table "${tableName}" not found`);
      const allRows = await db.select().from(rows).where(eq(rows.tableId, tableRow.id));
      const toDelete = allRows.filter((r) => {
        const d = JSON.parse(r.data);
        return Object.entries(filter).every(([k, v]) => d[k] === v);
      });
      for (const r of toDelete) {
        await db.delete(rows).where(eq(rows.id, r.id));
      }
      return { deleted: toDelete.length };
    },
  };

  // Execute tool code in a restricted context
  const fn = new Function('input', 'db', `"use strict"; return (async () => { ${code} })();`);
  const result = await fn(input, dbProxy);
  return typeof result === 'string' ? result : JSON.stringify(result);
}
