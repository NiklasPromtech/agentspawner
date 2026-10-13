/**
 * Ensures every existing agent has all currently-defined default tools.
 * Called once at startup — idempotent (skips tools already present by name).
 */

import { getDb } from '../db/index.js';
import { agents, tools } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_TOOLS } from './default-tools.js';
import { logger } from '../lib/logger.js';

// All tools that should exist for every agent (including web_fetch which is
// handled separately from DEFAULT_TOOLS in agents.ts)
const WEB_FETCH_TOOL = {
  name: 'web_fetch',
  description: 'Fetch the content of any URL and return the raw text. Use for reading web pages, APIs, or public documents.',
  toolType: 'web_fetch',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
    },
    required: ['url'],
  },
  code: '',
};

const ALL_DEFAULT_TOOLS = [WEB_FETCH_TOOL, ...DEFAULT_TOOLS];

export async function provisionMissingTools(): Promise<void> {
  const db = getDb();

  const allAgents = await db.select().from(agents);

  for (const agent of allAgents) {
    // Get names of tools this agent already has
    const existingTools = await db
      .select({ name: tools.name })
      .from(tools)
      .where(eq(tools.agentId, agent.id));

    const existingNames = new Set(existingTools.map((t) => t.name));

    // Insert any missing tools
    for (const tool of ALL_DEFAULT_TOOLS) {
      if (!existingNames.has(tool.name)) {
        await db.insert(tools).values({
          id: uuidv4(),
          agentId: agent.id,
          name: tool.name,
          description: tool.description,
          toolType: tool.toolType,
          inputSchema: JSON.stringify(tool.inputSchema),
          code: tool.code,
        });
        logger.info({ toolName: tool.name, agentName: agent.name, agentId: agent.id }, 'provision-tools: added tool to agent');
      }
    }
  }
}
