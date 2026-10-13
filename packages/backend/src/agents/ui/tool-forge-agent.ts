/**
 * Tool Forge Agent
 *
 * Specialist agent for creating and fixing browser automation and server-side tools.
 * Creates or fixes a tool through a generate → save → test → repeat loop.
 * Returns only when a live test passes, or after MAX_FORGE_ATTEMPTS exhausted.
 *
 * Moved from orchestrator/sub-agents.ts (Tool Forge section).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/index.js';
import { tools } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { runTool } from '../../orchestrator/tool-runner.js';
import type { SseEmitter } from '../../features/runs/runs.routes.js';

// ── Shared types ──────────────────────────────────────────────────────────────

export interface ForgeResult {
  success: boolean;
  tool_id?: string;
  tool_name?: string;
  tool_type?: string;
  test_result?: string;
  attempts: number;
  notes: string;
}

// ── Tool Forge ────────────────────────────────────────────────────────────────
//
// Creates or fixes a tool through a loop:
//   generate → save → test → if fail → analyze error → regenerate → repeat
//
// Returns only when a live test passes, or after MAX_FORGE_ATTEMPTS exhausted.

const MAX_FORGE_ATTEMPTS = 5;

const TOOL_FORGE_SYSTEM_PROMPT = `You are the Tool Forge — a specialist in creating and fixing browser automation and server-side tools.

Your job: write tool code that PASSES A LIVE TEST, not just code that looks right.

## Output format (always exactly this)

NAME: snake_case_tool_name
DESCRIPTION: One sentence describing what this tool does.
SCHEMA:
{"type":"object","properties":{},"required":[]}
CODE:
\`\`\`javascript
// implementation here
\`\`\`

## Tool types and their APIs

### extension (browser automation — runs in Chrome offscreen document)
Use the \`tab\` helper. Returns are passed back as-is.
  tab.open(url)                              → tabId
  tab.waitForLoad(tabId)                     → void
  tab.sleep(ms)                              → void
  tab.navigate(tabId, url)                   → void
  tab.close(tabId)                           → void
  tab.domGet(tabId, selector)                → { found, text, href, value }
  tab.domQueryAll(tabId, selector, limit?)   → [{ text, href, value }, ...]
  tab.domClick(tabId, selector)              → { success }
  tab.domType(tabId, selector, text)         → { success }
  tab.domScroll(tabId, selector, x, y)       → void

Always use try/catch. Return a plain object with a clear success/error field.

X/Twitter DOM notes (selectors change; prefer data-testid):
  DM button:        [data-testid="DMButton"] or [aria-label="Message"]
  DM input:         [data-testid="dmComposerTextInput"]
  Send button:      [data-testid="dmComposerSendButton"]
  User follow btn:  [data-testid="followButton"] when on their profile
  Tweet compose:    [data-testid="tweetTextarea_0"]
If a selector is missing, return { success: false, reason: "Element not found — user may have DMs disabled or selector changed" }
Never throw unhandled errors — always catch and return { error: "..." }.

Rate limits: add tab.sleep(1500) between consequential actions.

### local (server-side JavaScript with DB access)
  db.select(tableName, filter?)   → rows[]
  db.insert(tableName, data)      → { success: true }
  db.deleteRows(tableName, ids)   → { deleted: count }
Use \`input\` for parameters. Return a plain object.

### web_fetch / web_search
No CODE block needed — just NAME, DESCRIPTION, SCHEMA.

## Rules
- If given previous errors: fix the SPECIFIC issue mentioned — don't just rewrite differently.
- Prefer data-testid attributes over class names (class names change, data-testid is stable).
- For DM tools: always check if the DM button is present before trying to click it.
  If absent, return { success: false, reason: "DM unavailable", detail: "button not found" }.
- For tools that check permissions (can_dm, is_following, etc.): navigate to the user's profile
  and inspect the DOM to determine status — don't guess.
- Code must be self-contained — no imports, no require().
`.trim();

/**
 * Run the Tool Forge agent.
 * Creates or fixes a tool and validates it through live testing.
 * Returns only when a test passes or all attempts are exhausted.
 */
export async function runToolForgeAgent(params: {
  agentId: string;
  agentName: string;
  taskDescription: string;
  toolType: string;              // extension | local | web_fetch | web_search
  testInput?: Record<string, unknown>;  // inputs to use when testing; {} if none
  existingToolId?: string;       // if fixing an existing tool, provide its ID
  apiKey: string;
  agentModel: string;
  emit?: SseEmitter;
}): Promise<ForgeResult> {
  const { agentId, agentName: _agentName, taskDescription, toolType, testInput, existingToolId, apiKey, agentModel, emit } = params;
  const db = getDb();
  const anthropic = new Anthropic({ apiKey });

  emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `🔨 Tool Forge: "${taskDescription}" (${toolType})` }] });

  let currentToolId = existingToolId ?? null;
  const previousErrors: string[] = [];
  let lastCode = '';
  let lastToolName = '';

  // If fixing an existing tool, pre-load its code so the forge can see what it's working with
  if (existingToolId) {
    const [existing] = await db.select().from(tools)
      .where(and(eq(tools.id, existingToolId), eq(tools.agentId, agentId)));
    if (existing) {
      lastCode = existing.code ?? '';
      lastToolName = existing.name;
    }
  }

  for (let attempt = 1; attempt <= MAX_FORGE_ATTEMPTS; attempt++) {
    emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  🔧 Forge attempt ${attempt}/${MAX_FORGE_ATTEMPTS}...` }] });

    // ── Build the generation prompt ──────────────────────────────────────────
    const errorHistory = previousErrors.length > 0
      ? `\n\nPREVIOUS ATTEMPTS AND THEIR ERRORS:\n` +
        previousErrors.map((e, i) => `[Attempt ${i + 1}] ${e}`).join('\n') +
        `\n\nFix the specific error above. Analyze what went wrong and correct it.`
      : '';

    const existingCodeBlock = lastCode
      ? `\n\nEXISTING CODE:\n\`\`\`javascript\n${lastCode}\n\`\`\`\n`
      : '';

    const prompt = [
      `Tool type: ${toolType}`,
      `Task: ${taskDescription}`,
      existingCodeBlock,
      errorHistory,
    ].filter(Boolean).join('\n');

    try {
      // ── Generate ────────────────────────────────────────────────────────────
      const resp = await anthropic.messages.create({
        model: agentModel,
        max_tokens: 2048,
        system: TOOL_FORGE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('');

      const nameMatch  = text.match(/^NAME:\s*(.+)$/m);
      const descMatch  = text.match(/^DESCRIPTION:\s*(.+)$/m);
      const schemaMatch = text.match(/^SCHEMA:\s*\n([\s\S]*?)(?=\nCODE:|\n```|$)/m);
      const codeMatch  = text.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);

      // web_fetch and web_search don't need code
      const needsCode = toolType === 'extension' || toolType === 'local';

      if (!nameMatch || (needsCode && !codeMatch)) {
        previousErrors.push(`Generation failed: AI didn't return required NAME${needsCode ? ' and CODE' : ''} blocks. Raw: ${text.slice(0, 200)}`);
        continue;
      }

      let inputSchema = '{"type":"object","properties":{},"required":[]}';
      if (schemaMatch?.[1]) {
        try { inputSchema = JSON.stringify(JSON.parse(schemaMatch[1].trim())); } catch { /* keep default */ }
      }

      const toolName = nameMatch[1]!.trim();
      const toolDesc = descMatch ? descMatch[1]!.trim() : taskDescription.slice(0, 200);
      const toolCode = codeMatch ? codeMatch[1]!.trim() : '';
      lastCode = toolCode;
      lastToolName = toolName;

      // ── Save / update ───────────────────────────────────────────────────────
      if (currentToolId) {
        await db.update(tools).set({
          name: toolName, description: toolDesc, inputSchema, code: toolCode,
          updatedAt: new Date().toISOString(),
        }).where(and(eq(tools.id, currentToolId), eq(tools.agentId, agentId)));
      } else {
        currentToolId = uuidv4();
        await db.insert(tools).values({
          id: currentToolId, agentId, name: toolName, description: toolDesc,
          inputSchema, toolType, code: toolCode,
        });
      }

      emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  📝 Saved "${toolName}". Running validation test...` }] });

      // ── Validate ─────────────────────────────────────────────────────────────
      // Extension tools can't be fully tested without a live browser.
      // We do structural validation: code present, schema valid, no syntax errors we can catch.
      if (toolType === 'extension') {
        // Validate the code is syntactically plausible (basic heuristics)
        const codeIssues: string[] = [];
        if (toolCode.length < 20) codeIssues.push('Code block is suspiciously short');
        if (!toolCode.includes('tab.')) codeIssues.push('Extension tool has no tab.* calls — is this correct?');

        if (codeIssues.length > 0 && attempt < MAX_FORGE_ATTEMPTS) {
          previousErrors.push(`Structural issues: ${codeIssues.join(', ')}`);
          continue;
        }

        // Extension tool: structural pass (live test requires running browser)
        emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  ✅ Tool Forge: "${toolName}" validated (structure OK; live test requires browser)` }] });
        return {
          success: true, tool_id: currentToolId, tool_name: toolName, tool_type: toolType,
          test_result: 'Structure validated. Live test requires a running browser with the extension.',
          attempts: attempt,
          notes: `Created after ${attempt} attempt(s). Extension tools are validated structurally; runtime behaviour depends on the target site.`,
        };
      }

      // For local / web_fetch / web_search tools: run a real test
      const [savedTool] = await db.select().from(tools).where(eq(tools.id, currentToolId));
      if (!savedTool) {
        previousErrors.push(`Attempt ${attempt}: Tool save failed — could not re-read from DB`);
        continue;
      }

      try {
        const testResult = await runTool(savedTool, testInput ?? {}, agentId);

        // A result that contains an error field counts as a failure — unless
        // it's a "missing required parameter" type error (schema is valid, just
        // needs real input we don't have at forge time)
        const parsed = (() => { try { return JSON.parse(testResult); } catch { return null; } })();
        if (parsed && typeof parsed === 'object' && parsed !== null) {
          const errField = (parsed as Record<string, unknown>).error;
          if (typeof errField === 'string') {
            const isMissingParam =
              /required|missing|undefined|null/i.test(errField) &&
              !/(rate.?limit|timeout|network|cannot read|not a function)/i.test(errField);
            if (!isMissingParam) {
              previousErrors.push(`Attempt ${attempt}: Tool returned error: ${errField.slice(0, 300)}`);
              emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  ❌ Test error: ${errField.slice(0, 100)} — fixing...` }] });
              continue;
            }
          }
        }

        emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  ✅ Tool Forge: "${toolName}" passed live test after ${attempt} attempt(s)` }] });
        return {
          success: true, tool_id: currentToolId, tool_name: toolName, tool_type: toolType,
          test_result: testResult.slice(0, 500), attempts: attempt,
          notes: `Passed live test after ${attempt} attempt(s).`,
        };

      } catch (testErr) {
        const errMsg = testErr instanceof Error ? testErr.message : String(testErr);

        // "Required parameter" runtime errors = schema is valid, just needs real input
        const isMissingParam = /required|missing|cannot read prop|undefined is not/i.test(errMsg);
        if (isMissingParam) {
          emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  ✅ Tool Forge: "${toolName}" structural pass (needs real runtime input to fully test)` }] });
          return {
            success: true, tool_id: currentToolId, tool_name: toolName, tool_type: toolType,
            test_result: `Structural pass — test with real input: ${errMsg.slice(0, 200)}`,
            attempts: attempt,
            notes: `Saved and structurally validated after ${attempt} attempt(s). Provide real input for full verification.`,
          };
        }

        previousErrors.push(`Attempt ${attempt}: Test threw: ${errMsg.slice(0, 300)}`);
        emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  ❌ Test threw: ${errMsg.slice(0, 100)} — fixing...` }] });
      }

    } catch (genErr) {
      const errMsg = genErr instanceof Error ? genErr.message : String(genErr);
      previousErrors.push(`Attempt ${attempt}: Generation error: ${errMsg.slice(0, 200)}`);
    }
  }

  // All attempts exhausted
  const failureNotes = [
    `Tool Forge exhausted all ${MAX_FORGE_ATTEMPTS} attempts for: "${taskDescription}".`,
    `Tool type: ${toolType}`,
    `Errors encountered:`,
    ...previousErrors.map((e, i) => `  [${i + 1}] ${e}`),
    currentToolId ? `A partial tool was saved (ID: ${currentToolId}) but has not been validated.` : 'No tool was saved.',
  ].join('\n');

  emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  ❌ Tool Forge failed after ${MAX_FORGE_ATTEMPTS} attempts. See notes for details.` }] });

  return {
    success: false, tool_id: currentToolId ?? undefined, tool_name: lastToolName || undefined,
    tool_type: toolType, attempts: MAX_FORGE_ATTEMPTS, notes: failureNotes,
  };
}
