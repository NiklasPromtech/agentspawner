import type { FastifyInstance } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { agents } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../../crypto/index.js';

// ── Schema ─────────────────────────────────────────────────────────────────────

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

const ChatBody = z.object({
  message: z.string().min(1),
  history: z.array(MessageSchema).default([]),
  flowContext: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    flowType: z.string().nullable().optional(),
    steps: z.array(z.any()).optional(),
  }).optional(),
});

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Flow Master, an expert assistant embedded inside a flow editor for an automation platform.

## What you know about flows

A flow is a sequence of steps that runs automatically. Each step calls a tool and passes its output to the next step via \`step_ref\` input mappings.

### Step types
- **Tool steps** — call a browser extension tool (e.g. \`open_tab\`, \`get_text\`, \`get_dom_filtered\`, \`click\`, \`type_text\`, \`screenshot\`)
- **\`__transform__\`** — runs a sandboxed JavaScript function. Receives \`input\` (an object built from inputMapping) and must \`return\` a value. Runs in a Node.js VM with a 2-second timeout. No DOM, no external modules, no \`require\`. Only standard JS (ES2020) is available.
- **\`__evaluate__\`** — an AI-powered conditional. Evaluates a prompt against the step result and decides whether to continue or stop.
- **\`__generate__\`** — calls an LLM to produce text (used for content flows).
- **\`__hydrate__\`** — re-fetches references in an ActionBrief (used before __generate__ in action flows).

### Input mapping types
- \`flow_input\` — reads a value the caller passed in (e.g. \`{ type: "flow_input", key: "url" }\`)
- \`step_ref\` — reads a field from a prior step's output (e.g. \`{ type: "step_ref", stepId: "...", path: "html" }\`)
- \`literal\` — a hardcoded value (e.g. \`{ type: "literal", value: "https://..." }\`)

### __transform__ script rules
- The script is a **function body** — it receives \`input\` (object) and must \`return\` something.
- No \`async\`, no Promises, no external libraries.
- Use regex, string methods, and plain JS objects/arrays.
- To decode HTML entities in the sandbox: \`.replace(/&amp;/g, '&').replace(/&lt;/g, '<')...\` etc.
- The result becomes that step's output and can be referenced by later steps.

### Flow types
- **scrape** — read-only. Returns structured data. No screenshot required.
- **action** — makes changes (clicks, types, posts). Must include a screenshot step second-to-last to confirm success.

## Your job
Answer questions about building flows, debugging selectors, writing __transform__ scripts, understanding step outputs, and anything else related to the flow the user is editing.

Be concise and practical. When writing code, use plain JavaScript. When relevant, note if something requires a specific step type.

The user's current flow context is injected into their messages. Use it to give specific, grounded answers.`;

// ── Route ──────────────────────────────────────────────────────────────────────

export function registerFlowMasterRoutes(fastify: FastifyInstance) {
  fastify.post<{ Params: { agentId: string }; Body: z.infer<typeof ChatBody> }>(
    '/agents/:agentId/flow-master/chat',
    async (req, reply) => {
      const body = ChatBody.parse(req.body);
      const { agentId } = req.params;

      const db = getDb();
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return reply.status(404).send({ error: 'Agent not found' });

      const apiKey = decrypt(agent.apiKeyEncrypted);
      if (!apiKey) return reply.status(400).send({ error: 'Agent has no API key configured' });

      const anthropic = new Anthropic({ apiKey });

      // Build context block for the current message
      let contextBlock = '';
      if (body.flowContext) {
        const { name, description, flowType, steps } = body.flowContext;
        const lines: string[] = ['[Current flow context]'];
        if (name) lines.push(`Name: ${name}`);
        if (description) lines.push(`Description: ${description}`);
        if (flowType) lines.push(`Type: ${flowType}`);
        if (steps && steps.length > 0) {
          lines.push(`Steps (${steps.length}):`);
          for (const [i, step] of steps.entries()) {
            const toolName = (step as { label?: string; toolId?: string }).label ?? (step as { toolId?: string }).toolId ?? '?';
            lines.push(`  ${i + 1}. ${toolName}`);
          }
        }
        contextBlock = lines.join('\n') + '\n\n';
      }

      // Build message history
      const messages: Anthropic.MessageParam[] = [
        ...body.history.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: `${contextBlock}${body.message}` },
      ];

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
      });

      const replyText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as Anthropic.TextBlock).text)
        .join('');

      return reply.send({ reply: replyText });
    }
  );
}
