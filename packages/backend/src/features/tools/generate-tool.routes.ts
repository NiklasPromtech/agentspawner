import type { FastifyInstance } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { agents } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../../crypto/index.js';

const GenerateBody = z.object({
  agentId: z.string(),
  prompt: z.string().min(1),
  toolType: z.enum(['extension', 'web_search', 'web_fetch', 'local']).default('extension'),
  existingCode: z.string().optional(),
});

const SYSTEM_PROMPT = `You are an expert at creating tool definitions for an AI agent system.
Generate or edit a tool definition using EXACTLY this format:

NAME: snake_case_tool_name
DESCRIPTION: One sentence describing what the tool does.
SCHEMA:
{"type":"object","properties":{},"required":[]}
CODE:
\`\`\`javascript
// implementation here
\`\`\`

Rules:
- NAME must be snake_case with no spaces
- DESCRIPTION must be a single sentence
- SCHEMA must be valid JSON (no backticks, no trailing commas)
- CODE must be inside a javascript fenced code block

## Tool types and execution environments

### extension tools
Code runs in the OFFSCREEN document (not in a tab). Use the \`tab\` helper to interact with pages.

**Full \`tab\` API — use these, in order of preference:**

Navigation & lifecycle:
- \`const tabId = await tab.open(url, active?)\` → opens tab, returns tabId (number). active defaults to true.
- \`await tab.waitForLoad(tabId)\` → waits for DOMContentLoaded / page complete
- \`await tab.sleep(ms)\` → wait for dynamic content to render
- \`await tab.navigate(tabId, url)\` → navigate existing tab to new URL
- \`await tab.close(tabId)\` → close tab when done

Reading the page (prefer these over exec):
- \`const items = await tab.domQueryAll(tabId, selector, limit?)\` → array of \`{text, tag, href, src, value}\`. Default limit 100. Best for lists.
- \`const items = await tab.domGetAll(tabId, selector, limit?)\` → same shape, default limit 50.
- \`const html = await tab.domGet(tabId, selector)\` → outerHTML string of first match (null if not found). Pass null selector for full page.
- \`const b64 = await tab.screenshot(tabId)\` → PNG as base64 data URL

Interaction (prefer these over exec):
- \`await tab.domClick(tabId, selector)\` → scroll into view and click
- \`await tab.domType(tabId, selector, text)\` → focus, set value, fire input+change events
- \`await tab.domScroll(tabId, selector, x, y)\` → scroll element (or page if selector null) by x/y pixels

Waiting:
- \`const label = await tab.waitForAny(tabId, [{selector, label}, ...], timeoutMs?)\` → races selectors, returns winning label or "timeout"

**LAST RESORT — \`tab.exec(tabId, codeString)\`:**
Only use when the task genuinely cannot be done with the primitives above — e.g. firing keyboard events, interacting with canvas/WebGL, reading window-scoped JS variables. Keep the code string minimal.

Example — scrape a list (preferred pattern):
\`\`\`javascript
const tabId = await tab.open(\`https://example.com/search?q=\${encodeURIComponent(input.query)}\`);
await tab.waitForLoad(tabId);
await tab.sleep(1000);
const items = await tab.domQueryAll(tabId, '.result', 10);
await tab.close(tabId);
return items.map(r => ({ title: r.text, url: r.href }));
\`\`\`

Example — interact then read:
\`\`\`javascript
const tabId = await tab.open('https://example.com/dashboard');
await tab.waitForLoad(tabId);
await tab.domClick(tabId, '[data-testid="load-more"]');
await tab.sleep(800);
const rows = await tab.domQueryAll(tabId, '[data-testid="row"]', 50);
await tab.close(tabId);
return rows;
\`\`\`

### local tools
Code runs server-side with a \`db\` proxy:
- \`db.select(tableName, filter?)\` → array of rows
- \`db.insert(tableName, data)\` → {success: true}
- \`db.deleteRows(tableName, filter)\` → {deleted: count}
Use \`input\` for parameters. Return a value.

### web_fetch tools
No code needed (leave CODE block empty). The tool fetches a URL from input.url server-side.

### web_search tools
No code needed (leave CODE block empty). Uses Anthropic native web search.`;

export function registerGenerateToolRoute(fastify: FastifyInstance): void {
  fastify.post('/generate-tool', async (req, reply) => {
    const db = getDb();
    const body = GenerateBody.parse(req.body);

    const [agent] = await db.select().from(agents).where(eq(agents.id, body.agentId));
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const apiKey = decrypt(agent.apiKeyEncrypted);
    if (!apiKey) return reply.status(400).send({ error: 'Agent has no API key configured' });

    const anthropic = new Anthropic({ apiKey });

    // Build user message — editing vs. creating
    let userMessage: string;
    if (body.existingCode?.trim()) {
      userMessage = [
        `Tool type: ${body.toolType}`,
        '',
        'Here is the existing tool code that needs to be updated:',
        '```javascript',
        body.existingCode.trim(),
        '```',
        '',
        `User request: ${body.prompt}`,
        '',
        'Please update the code to fulfil the request. Keep the same NAME and DESCRIPTION unless the request explicitly changes them.',
      ].join('\n');
    } else {
      userMessage = `Tool type: ${body.toolType}\n\nDescription: ${body.prompt}`;
    }

    const response = await anthropic.messages.create({
      model: agent.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');

    // Parse structured response
    const nameMatch = text.match(/^NAME:\s*(.+)$/m);
    const descMatch = text.match(/^DESCRIPTION:\s*(.+)$/m);
    const schemaMatch = text.match(/^SCHEMA:\s*\n([\s\S]*?)(?=\nCODE:|\n```|$)/m);
    const codeMatch = text.match(/```javascript\s*([\s\S]*?)```/);

    if (!nameMatch || !descMatch) {
      return reply.status(422).send({ error: 'Could not parse tool definition from AI response', raw: text });
    }

    const name = nameMatch[1]!.trim();
    const description = descMatch[1]!.trim();
    const code = codeMatch ? codeMatch[1]!.trim() : '';

    let inputSchema: unknown = { type: 'object', properties: {}, required: [] };
    if (schemaMatch?.[1]) {
      try {
        inputSchema = JSON.parse(schemaMatch[1].trim());
      } catch {
        // keep default
      }
    }

    return { name, description, inputSchema: JSON.stringify(inputSchema), code, toolType: body.toolType };
  });
}
