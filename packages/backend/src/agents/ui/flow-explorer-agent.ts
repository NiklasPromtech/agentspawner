/**
 * Flow Explorer Agent
 *
 * Freehand exploration phase that runs BEFORE the flow builder.
 *
 * Instead of having the builder guess at selectors and structure, the explorer
 * actually opens pages, calls tools, observes results, and iterates until it has
 * a verified working sequence. It then hands off a structured ExplorationReport
 * to the builder.
 *
 * The builder receives ground truth — not fiction.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/index.js';
import { tools } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { runTool } from '../../orchestrator/tool-runner.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Public types ──────────────────────────────────────────────────────────────

export interface ExplorationStep {
  tool: string;
  input: Record<string, unknown>;
  outputSummary: string;
  notes: string;
}

export interface ExplorationReport {
  success: boolean;
  taskDescription: string;
  approach: string;
  workingSteps: ExplorationStep[];
  inputsNeeded: Array<{ key: string; description: string; exampleValue: string }>;
  dataShape: string;
  failedApproaches: Array<{ approach: string; reason: string }>;
  additionalNotes: string;
}

// ── SSE event types emitted by the explorer ───────────────────────────────────

export type ExplorerEvent =
  | { type: 'explorer_start' }
  | { type: 'explorer_thinking'; text: string }
  | { type: 'explorer_tool_call'; tool: string; displayText: string }
  | { type: 'explorer_tool_result'; tool: string; summary: string; ok: boolean }
  | { type: 'explorer_complete'; success: boolean; summary: string }
  | { type: 'explorer_error'; message: string };

// ── Constants ─────────────────────────────────────────────────────────────────

const EXPLORER_MODEL = 'claude-haiku-4-5-20251001';
const MAX_EXPLORER_ITERATIONS = 40;

// Max chars for tool results shown in conversation history — keeps context lean
const MAX_TOOL_RESULT_CHARS = 6_000;

function truncate(s: string): string {
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  return s.slice(0, MAX_TOOL_RESULT_CHARS) + `\n[... truncated ${s.length - MAX_TOOL_RESULT_CHARS} chars ...]`;
}

// ── Summarise a tool result for the SSE log ───────────────────────────────────

function summariseResult(toolName: string, raw: string): { summary: string; ok: boolean } {
  // Screenshots: don't try to parse, just note it
  if (raw.startsWith('data:image')) {
    return { summary: 'screenshot captured', ok: true };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (parsed.error) {
      return { summary: `error: ${String(parsed.error).slice(0, 120)}`, ok: false };
    }

    // Tool-specific summaries
    if (toolName === 'open_tab') return { summary: `tab opened (id: ${parsed.tabId ?? '?'})`, ok: true };
    if (toolName === 'close_tab') return { summary: 'tab closed', ok: true };
    if (toolName === 'wait_for_any') return { summary: `found: ${parsed.found ?? '?'}`, ok: !parsed.error };
    if (toolName === 'wait_for') return { summary: `found: ${parsed.found ?? '?'}`, ok: !!parsed.found };
    if (toolName === 'get_text') {
      const text = String(parsed.text ?? '');
      return { summary: `${text.length} chars of text`, ok: text.length > 0 };
    }
    if (toolName === 'get_dom') {
      const html = String(parsed.html ?? '');
      return { summary: `${html.length} chars of DOM`, ok: html.length > 0 };
    }
    if (toolName === 'click') return { summary: parsed.success ? 'clicked' : `click failed: ${parsed.error ?? '?'}`, ok: !!parsed.success };
    if (toolName === 'type_text') return { summary: parsed.success ? 'typed' : `type failed: ${parsed.error ?? '?'}`, ok: !!parsed.success };
    if (toolName === 'element_exists') return { summary: `exists: ${parsed.exists ?? parsed.label ?? '?'}`, ok: true };
    // Generic
    const keys = Object.keys(parsed).slice(0, 3).join(', ');
    return { summary: `{ ${keys}${Object.keys(parsed).length > 3 ? ', …' : ''} }`, ok: true };
  } catch {
    const s = raw.slice(0, 120);
    return { summary: s, ok: !raw.toLowerCase().includes('error') };
  }
}

// ── Build tool definitions for Claude from agent tools ────────────────────────

function buildClaudeToolDefs(
  agentTools: Array<{ name: string; description: string; inputSchema: string }>,
): Anthropic.Messages.Tool[] {
  const browserTools: Anthropic.Messages.Tool[] = agentTools
    // Only expose browser/fetch tools — not local DB tools during exploration
    .filter((t) => !t.name.startsWith('query_') && !t.name.startsWith('store_') && !t.name.startsWith('list_'))
    .map((t) => {
      let input_schema: Anthropic.Messages.Tool['input_schema'];
      try {
        input_schema = JSON.parse(t.inputSchema) as Anthropic.Messages.Tool['input_schema'];
      } catch {
        input_schema = { type: 'object' as const, properties: {}, required: [] };
      }
      return { name: t.name, description: t.description, input_schema };
    });

  // Add the finish_exploration sentinel tool
  browserTools.push({
    name: 'finish_exploration',
    description:
      'Call this when you have a confirmed working sequence (or when exploration is impossible). Summarise everything you found — the builder depends on this.',
    input_schema: {
      type: 'object' as const,
      properties: {
        success: {
          type: 'boolean',
          description: 'true if you found a working approach, false if impossible (bot detection, auth, Shadow DOM, etc.)',
        },
        approach: {
          type: 'string',
          description: 'One sentence describing the working approach (e.g. "open_tab + wait_for_any + get_text with JSON transform")',
        },
        working_steps: {
          type: 'array',
          description: 'The exact sequence of tool calls that worked, in order',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'Tool name' },
              input: { type: 'object', description: 'Input you used (with example/literal values)' },
              output_summary: { type: 'string', description: 'What the tool returned (key fields, shape, size)' },
              notes: { type: 'string', description: 'Anything important about this step' },
            },
            required: ['tool', 'input', 'output_summary', 'notes'],
          },
        },
        inputs_needed: {
          type: 'array',
          description: 'What inputs the user needs to provide at runtime (URL, handle, etc.)',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              description: { type: 'string' },
              example_value: { type: 'string', description: 'The actual value you used during exploration' },
            },
            required: ['key', 'description', 'example_value'],
          },
        },
        data_shape: {
          type: 'string',
          description: 'Description of what the final extracted data looks like (fields, types, example values)',
        },
        failed_approaches: {
          type: 'array',
          description: 'Things you tried that did not work',
          items: {
            type: 'object',
            properties: {
              approach: { type: 'string' },
              reason: { type: 'string', description: 'Why it failed' },
            },
            required: ['approach', 'reason'],
          },
        },
        open_tab_ids: {
          type: 'array',
          description: 'IDs of any tabs still open that need to be closed',
          items: { type: 'number' },
        },
        additional_notes: {
          type: 'string',
          description: 'Any other observations the builder should know (page quirks, timing, Shadow DOM issues, etc.)',
        },
        failure_reason: {
          type: 'string',
          description: 'If success=false, explain exactly why exploration failed',
        },
      },
      required: ['success', 'approach', 'working_steps', 'inputs_needed', 'data_shape'],
    },
  });

  return browserTools;
}

// ── Build the explorer system prompt ─────────────────────────────────────────

function buildExplorerSystemPrompt(
  agentTools: Array<{ name: string; description: string; inputSchema: string }>,
  taskDescription: string,
  flowType: 'scrape' | 'action',
): string {
  const toolCatalog = agentTools
    .filter((t) => !t.name.startsWith('query_') && !t.name.startsWith('store_') && !t.name.startsWith('list_'))
    .map((t) => {
      let props = '';
      try {
        const s = JSON.parse(t.inputSchema) as { properties?: Record<string, { type?: string; description?: string }> };
        if (s.properties && Object.keys(s.properties).length > 0) {
          props =
            '\n' +
            Object.entries(s.properties)
              .map(([k, v]) => `    ${k} (${v.type ?? 'any'}): ${v.description ?? ''}`)
              .join('\n');
        }
      } catch { /* ignore */ }
      return `- ${t.name}: ${t.description}${props}`;
    })
    .join('\n');

  const template = readFileSync(join(__dirname, 'flow-explorer.prompt.md'), 'utf-8');
  return template
    .replace('{{TASK_DESCRIPTION}}', taskDescription)
    .replace('{{FLOW_TYPE}}', flowType)
    .replace('{{TOOL_CATALOG}}', toolCatalog || '(no browser tools installed — exploration is not possible)');
}

// ── Cleanup open tabs ──────────────────────────────────────────────────────────

async function closeOpenTabs(
  tabIds: number[],
  agentTools: Array<{ id: string; name: string; description: string; inputSchema: string; toolType: string; code: string | null }>,
  agentId: string,
): Promise<void> {
  const closeTab = agentTools.find((t) => t.name === 'close_tab');
  if (!closeTab || tabIds.length === 0) return;

  for (const tabId of tabIds) {
    try {
      await runTool({ ...closeTab, code: closeTab.code ?? '' }, { tabId }, agentId);
    } catch { /* ignore cleanup errors */ }
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runFlowExplorer(params: {
  agentId: string;
  apiKey: string;
  agentTools: Array<{ id: string; name: string; description: string; inputSchema: string; toolType: string; code: string | null }>;
  taskDescription: string;
  flowType: 'scrape' | 'action';
  isOpen: () => boolean;
}, emit: (event: ExplorerEvent) => void): Promise<ExplorationReport> {
  emit({ type: 'explorer_start' });

  const anthropic = new Anthropic({ apiKey: params.apiKey });
  const claudeTools = buildClaudeToolDefs(params.agentTools);
  const systemPrompt = buildExplorerSystemPrompt(params.agentTools, params.taskDescription, params.flowType);

  const toolByName = new Map(params.agentTools.map((t) => [t.name, t]));

  // Track open tabs so we can clean up if something goes wrong
  const openTabIds: number[] = [];

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: 'user',
      content: `Task to explore:\n\n${params.taskDescription}\n\nPlease start exploring now. Open the target URL and begin figuring out how to automate this.`,
    },
  ];

  let iterations = 0;

  try {
    while (iterations < MAX_EXPLORER_ITERATIONS) {
      if (!params.isOpen()) {
        // Client disconnected — clean up and return a failure report
        await closeOpenTabs(openTabIds, params.agentTools, params.agentId);
        return {
          success: false,
          taskDescription: params.taskDescription,
          approach: 'Client disconnected',
          workingSteps: [],
          inputsNeeded: [],
          dataShape: '',
          failedApproaches: [],
          additionalNotes: 'Client disconnected before exploration completed.',
        };
      }

      iterations++;

      const response = await anthropic.messages.create({
        model: EXPLORER_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools: claudeTools,
      });

      // Stream thinking text
      const textContent = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      if (textContent) {
        emit({ type: 'explorer_thinking', text: textContent });
      }

      // End of conversation — Claude responded with text only (shouldn't happen normally)
      if (response.stop_reason === 'end_turn') {
        await closeOpenTabs(openTabIds, params.agentTools, params.agentId);
        return {
          success: false,
          taskDescription: params.taskDescription,
          approach: 'Explorer ended without calling finish_exploration',
          workingSteps: [],
          inputsNeeded: [],
          dataShape: '',
          failedApproaches: [],
          additionalNotes: textContent,
        };
      }

      if (response.stop_reason !== 'tool_use') {
        break;
      }

      // Process tool calls
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        if (!params.isOpen()) break;

        const toolName = block.name;
        const toolInput = block.input as Record<string, unknown>;

        // ── finish_exploration ────────────────────────────────────────────────
        if (toolName === 'finish_exploration') {
          const finishInput = toolInput as {
            success: boolean;
            approach: string;
            working_steps?: Array<{ tool: string; input: Record<string, unknown>; output_summary: string; notes: string }>;
            inputs_needed?: Array<{ key: string; description: string; example_value: string }>;
            data_shape?: string;
            failed_approaches?: Array<{ approach: string; reason: string }>;
            open_tab_ids?: number[];
            additional_notes?: string;
            failure_reason?: string;
          };

          // Close any tabs Claude reported as open
          const tabsToClose = [...openTabIds];
          if (finishInput.open_tab_ids) {
            for (const id of finishInput.open_tab_ids) {
              if (!tabsToClose.includes(id)) tabsToClose.push(id);
            }
          }
          await closeOpenTabs(tabsToClose, params.agentTools, params.agentId);

          const report: ExplorationReport = {
            success: finishInput.success,
            taskDescription: params.taskDescription,
            approach: finishInput.approach,
            workingSteps: (finishInput.working_steps ?? []).map((s) => ({
              tool: s.tool,
              input: s.input,
              outputSummary: s.output_summary,
              notes: s.notes,
            })),
            inputsNeeded: (finishInput.inputs_needed ?? []).map((i) => ({
              key: i.key,
              description: i.description,
              exampleValue: i.example_value,
            })),
            dataShape: finishInput.data_shape ?? '',
            failedApproaches: (finishInput.failed_approaches ?? []).map((f) => ({
              approach: f.approach,
              reason: f.reason,
            })),
            additionalNotes: finishInput.additional_notes ?? finishInput.failure_reason ?? '',
          };

          const summary = finishInput.success
            ? `Working approach: ${finishInput.approach}`
            : `Exploration failed: ${finishInput.failure_reason ?? finishInput.approach}`;

          emit({ type: 'explorer_complete', success: finishInput.success, summary });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ ok: true }),
          });

          // Push final state and return
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: toolResults });

          return report;
        }

        // ── Regular browser tool ──────────────────────────────────────────────
        const toolRecord = toolByName.get(toolName);

        // Display the tool call
        const displayText = buildToolDisplayText(toolName, toolInput);
        emit({ type: 'explorer_tool_call', tool: toolName, displayText });

        let rawResult: string;

        if (!toolRecord) {
          rawResult = JSON.stringify({ error: `Tool "${toolName}" not found in agent tools` });
        } else {
          try {
            rawResult = await runTool({ ...toolRecord, code: toolRecord.code ?? '' }, toolInput, params.agentId);
          } catch (err) {
            rawResult = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          }
        }

        // Track open tabs for cleanup
        if (toolName === 'open_tab') {
          try {
            const result = JSON.parse(rawResult) as { tabId?: number };
            if (result.tabId !== undefined) openTabIds.push(result.tabId);
          } catch { /* ignore */ }
        }
        if (toolName === 'close_tab') {
          const tabId = toolInput.tabId as number | undefined;
          if (tabId !== undefined) {
            const idx = openTabIds.indexOf(tabId);
            if (idx !== -1) openTabIds.splice(idx, 1);
          }
        }

        const { summary, ok } = summariseResult(toolName, rawResult);
        emit({ type: 'explorer_tool_result', tool: toolName, summary, ok });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: truncate(rawResult),
        });
      }

      // Append this turn to conversation history
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    // Hit iteration limit — clean up and return failure
    await closeOpenTabs(openTabIds, params.agentTools, params.agentId);
    emit({ type: 'explorer_error', message: 'Explorer hit iteration limit without completing' });

    return {
      success: false,
      taskDescription: params.taskDescription,
      approach: 'Hit iteration limit',
      workingSteps: [],
      inputsNeeded: [],
      dataShape: '',
      failedApproaches: [],
      additionalNotes: `Explorer ran for ${MAX_EXPLORER_ITERATIONS} iterations without calling finish_exploration.`,
    };
  } catch (err) {
    // Unexpected error — clean up and propagate as a failed report
    await closeOpenTabs(openTabIds, params.agentTools, params.agentId);
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: 'explorer_error', message });

    return {
      success: false,
      taskDescription: params.taskDescription,
      approach: 'Unexpected error during exploration',
      workingSteps: [],
      inputsNeeded: [],
      dataShape: '',
      failedApproaches: [],
      additionalNotes: message,
    };
  }
}

// ── Helper: build a human-readable display text for a tool call ───────────────

function buildToolDisplayText(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'open_tab':
      return `open_tab(${String(input.url ?? '').slice(0, 80)})`;
    case 'close_tab':
      return `close_tab(tabId: ${input.tabId ?? '?'})`;
    case 'wait_for_any': {
      const sels = input.selectors as Array<{ selector: string; label: string }> | undefined;
      const labels = sels?.map((s) => s.label).join(', ') ?? '?';
      return `wait_for_any(${labels})`;
    }
    case 'wait_for':
      return `wait_for(${String(input.selector ?? '').slice(0, 60)})`;
    case 'get_text':
      return `get_text(${String(input.selector ?? 'page').slice(0, 60)})`;
    case 'get_dom':
      return `get_dom(tabId: ${input.tabId ?? '?'})`;
    case 'click':
      return `click(${String(input.selector ?? '').slice(0, 60)})`;
    case 'type_text':
      return `type_text("${String(input.text ?? '').slice(0, 40)}")`;
    case 'screenshot':
      return `screenshot(tabId: ${input.tabId ?? '?'})`;
    case 'web_fetch':
      return `web_fetch(${String(input.url ?? '').slice(0, 80)})`;
    case 'element_exists':
      return `element_exists(${String(input.selector ?? '').slice(0, 60)})`;
    case 'navigate_to':
      return `navigate_to(${String(input.url ?? '').slice(0, 80)})`;
    default: {
      const keys = Object.keys(input).slice(0, 2);
      const preview = keys.map((k) => `${k}: ${String(input[k]).slice(0, 30)}`).join(', ');
      return `${toolName}(${preview})`;
    }
  }
}
