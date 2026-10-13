import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  systemPrompt: text('system_prompt').notNull().default(''),
  model: text('model').notNull().default('claude-sonnet-4-6'),
  apiKeyEncrypted: text('api_key_encrypted').notNull().default(''),
  telegramKeyEncrypted: text('telegram_key_encrypted').notNull().default(''),
  telegramChatId: text('telegram_chat_id').notNull().default(''),
  suppressionToken: text('suppression_token'), // nullable; generated on create; injected into system prompt
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  // ── Tone guide (Feature 4) ─────────────────────────────────────────────
  toneGuide: text('tone_guide'), // nullable JSON array of bullet strings
  toneGuideUpdatedAt: text('tone_guide_updated_at'),
  // ── OPERATION CONVERGENCE: Task 7 — tone learning error surfacing ──────
  toneRefreshError: text('tone_refresh_error'),          // nullable; last error message from refreshToneGuide()
  toneRefreshErrorAt: text('tone_refresh_error_at'),     // nullable ISO timestamp of that error
  // ── OPERATION KEYSTONE: Task 3 ────────────────────────────────────────
  profileBlob: text('profile_blob'), // nullable JSON: { jobDescription, competitors[], tone[], allowed[], restricted[], focus, mindset }
  profileBlobUpdatedAt: text('profile_blob_updated_at'), // nullable ISO timestamp
  // ── OPERATION CONVERGENCE: Task 10 — agent activity dashboard ─────────────
  status: text('status').notNull().default('idle'), // 'idle' | 'running' | 'error'
  lastActiveAt: text('last_active_at'), // nullable ISO timestamp; updated on every agent loop iteration
});

export const tools = sqliteTable('tools', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull(),
  inputSchema: text('input_schema').notNull().default('{}'), // JSON string
  toolType: text('tool_type').notNull().default('extension'), // extension | web_search | web_fetch | local
  code: text('code').notNull().default(''), // JS code for extension/local tools
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'), // pending | running | completed | failed | stopped
  trigger: text('trigger').notNull().default('manual'), // manual | schedule | telegram
  input: text('input').notNull().default(''),
  error: text('error'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  // T3 — model tagging: which model ran this session
  modelId: text('model_id'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // user | assistant | tool_result
  content: text('content').notNull(), // JSON string (Anthropic MessageParam content)
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// User-defined tables (local tool storage)
export const tables = sqliteTable('tables', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  columns: text('columns').notNull().default('[]'), // JSON: [{name, type}]
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const rows = sqliteTable('rows', {
  id: text('id').primaryKey(),
  tableId: text('table_id').notNull().references(() => tables.id, { onDelete: 'cascade' }),
  data: text('data').notNull().default('{}'), // JSON object
  // T4 — attribution: which run and flow_run wrote this row
  runId: text('run_id'),
  flowRunId: text('flow_run_id'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ── API Request Log ───────────────────────────────────────────────────────────
// Stores raw responses from every API tool call so agents can reference them
// later (e.g. inject_rows) without re-fetching.
export const apiRequestLog = sqliteTable('api_request_log', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  toolName: text('tool_name').notNull(),
  input: text('input').notNull().default('{}'),      // JSON: the tool input
  response: text('response').notNull().default('{}'), // JSON: the full response
  durationMs: integer('duration_ms'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  cron: text('cron').notNull(),
  input: text('input').notNull().default(''),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  timezone: text('timezone').notNull().default('Europe/Stockholm'),
  flowId: text('flow_id'), // nullable — no FK (simpler deletion semantics)
  lastRunAt: text('last_run_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const memory = sqliteTable('memory', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
  category: text('category').notNull().default('other'), // 'profile' | 'post' | 'interaction' | 'research' | 'market_data' | 'web_content' | 'data' | 'other'
  entities: text('entities').notNull().default('[]'), // JSON: string[]
  sourceAgentId: text('source_agent_id'),   // FK (no cascade) — provenance
  sourceAgentName: text('source_agent_name'),
  sourceTool: text('source_tool'),
  sourceUrl: text('source_url'),
  metadata: text('metadata').notNull().default('{}'), // JSON: extra fields
  rawHash: text('raw_hash').unique(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ── Goals ──────────────────────────────────────────────────────────────────────
// Hierarchical goal system: mission → objectives → tasks
// The autonomous agent reads these at session start and drives its work from them.
export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  parentId: text('parent_id'), // null for top-level; points to parent goal id
  type: text('type').notNull().default('task'), // mission | objective | task
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status').notNull().default('pending'), // pending | in_progress | completed | blocked | cancelled
  priority: integer('priority').notNull().default(3), // 1=critical, 2=high, 3=normal, 4=low
  dueDate: text('due_date'), // ISO date string, nullable
  notes: text('notes').notNull().default(''), // agent updates this with progress notes
  completedAt: text('completed_at'), // ISO datetime, set when status → completed
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ── pendingActions table REMOVED (OPERATION CONVERGENCE Task 4.5)
// Superseded by actionLog in OPERATION KEYSTONE. Migration 0011 drops the table.

// ── Performance Log ────────────────────────────────────────────────────────────
// Tracks outcomes of actions for long-term learning and strategy improvement.
// Agent records what happened (DM sent, lead qualified, etc.) + the outcome.
export const performanceLog = sqliteTable('performance_log', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  category: text('category').notNull().default('other'), // outreach | lead | content | tool | flow | other
  action: text('action').notNull(),         // what was done, e.g. "sent DM to @handle"
  outcome: text('outcome').notNull().default('unknown'), // success | failure | pending | unknown
  value: real('value').notNull().default(0), // numeric value (e.g. cost, score, count)
  notes: text('notes').notNull().default(''),
  metadata: text('metadata').notNull().default('{}'), // JSON: extra context
  runId: text('run_id'), // which session this came from
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ── API Tools ─────────────────────────────────────────────────────────────────
// Custom tools that make HTTP calls or run sandboxed JS scripts.
// These are exposed to the autonomous agent and usable as flow steps.
export const apiTools = sqliteTable('api_tools', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),                         // snake_case, used as tool name
  description: text('description').notNull(),
  inputSchema: text('input_schema').notNull().default('{"type":"object","properties":{},"required":[]}'), // JSON
  type: text('type').notNull().default('script'),       // 'script' | 'http'
  config: text('config').notNull().default('{}'),       // JSON: { code } or { method, url, headers, body }
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ── Agent Secrets ─────────────────────────────────────────────────────────────
// Key-value store for API keys and other secrets, scoped per agent.
// Injected as the `secrets` object inside API tool scripts and HTTP templates.
export const agentSecrets = sqliteTable('agent_secrets', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull(),
  /** Max requests per minute for this API key. null = no limit. */
  requestsPerMinute: integer('requests_per_minute'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ── Flow Runs ──────────────────────────────────────────────────────────────────
// One row per flow invocation — audit log of everything the agent has done via flows.
export const flowRuns = sqliteTable('flow_runs', {
  id: text('id').primaryKey(),
  flowId: text('flow_id').notNull(),
  flowName: text('flow_name').notNull(),
  agentId: text('agent_id').notNull(),
  runId: text('run_id'),                     // autonomous/chat run that triggered this
  input: text('input').notNull().default('{}'),     // JSON — what was passed in
  output: text('output'),                    // JSON — what came back (null if errored before result)
  evaluationPassed: integer('evaluation_passed', { mode: 'boolean' }), // null = no eval step
  evaluationReason: text('evaluation_reason'),
  durationMs: integer('duration_ms'),
  success: integer('success', { mode: 'boolean' }).notNull().default(true),
  error: text('error'),
  // T1 — reasoning: the agent's internal monologue before calling this flow
  reasoning: text('reasoning'),
  // T2 — goal linkage: which goal triggered this flow run
  goalId: text('goal_id'),
  // T3 — model tagging: which model made this decision
  modelId: text('model_id'),
  // ── pausedStepResults + pausedAt REMOVED (OPERATION CONVERGENCE Task 4.5)
  // Pause/resume machinery was removed; stepResults is the sole column now.
  // ── OPERATION KEYSTONE: Task 2 ────────────────────────────────────────────
  stepResults: text('step_results'), // nullable JSON: Record<stepId, unknown> — always written on completion
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ── Action Log (task 1.4) ──────────────────────────────────────────────────────
// Every action flow execution is logged here — whether it proceeded or was blocked.
// Guards query this before attempting any action (faster + cross-session vs vision check).
export const actionLog = sqliteTable('action_log', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  flowId: text('flow_id').notNull(),
  flowName: text('flow_name').notNull(),    // e.g. 'send_dm', 'comment_on_post'
  flowType: text('flow_type').notNull(),    // 'action' | 'scrape'
  keyField: text('key_field').notNull(),    // e.g. 'user_id'
  keyValue: text('key_value').notNull(),    // e.g. '@niklas'
  input: text('input').notNull().default('{}'),   // full JSON input to the flow
  result: text('result'),                   // flow result or guard block message
  blocked: integer('blocked', { mode: 'boolean' }).notNull().default(false), // true = guard triggered, action was NOT taken
  runId: text('run_id'),                    // which autonomous run triggered this
  // ── OPERATION KEYSTONE: Task 1 ────────────────────────────────────────────
  status: text('status').notNull().default('executed'), // 'pending_review' | 'executing' | 'approved' | 'approved_with_edits' | 'rejected' | 'executed' | 'failed' | 'blocked'
  blockedReason: text('blocked_reason'),    // nullable; human-readable reason with suggested next action
  finalContent: text('final_content'),      // nullable; the content actually used if human amended it
  reRunCount: integer('re_run_count').notNull().default(0), // incremented on each manual re-run from UI
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ── Contacts (task 6.3) ─────────────────────────────────────────────────────────
// Canonical contact record — every outreach flow reads from and writes back to this.
// Source of truth for who has been contacted and their current status.
export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),        // 'twitter' | 'linkedin' | 'instagram' | etc.
  handle: text('handle').notNull(),            // @username or profile URL
  displayName: text('display_name'),
  notes: text('notes').notNull().default(''),  // research notes about this person
  status: text('status').notNull().default('prospect'), // 'prospect' | 'contacted' | 'replied' | 'converted' | 'do_not_contact'
  lastAction: text('last_action'),             // flow name of last action, e.g. 'send_dm'
  lastActionAt: text('last_action_at'),
  lastActionInput: text('last_action_input').notNull().default('{}'), // JSON — full input to last action
  metadata: text('metadata').notNull().default('{}'), // JSON — extra platform-specific fields
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const flows = sqliteTable('flows', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull(),
  inputSchema: text('input_schema').notNull().default('{}'), // JSON string — flow-level inputs
  steps: text('steps').notNull().default('[]'), // JSON: FlowStep[]
  returnStepId: text('return_step_id'), // nullable — single step return; null = last step
  returnSteps: text('return_steps'),    // nullable JSON: {key:string,stepId:string}[] — multi-step return (overrides returnStepId)
  reasoningModel: text('reasoning_model'), // nullable — if set, this model writes the final answer
  reasoningPrompt: text('reasoning_prompt'), // nullable — system prompt for the reasoning model
  resultMessage: text('result_message'),    // nullable — if set, prepended to the result returned to the AI (supports {{result}} placeholder)
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false), // human-approved / locked flow
  flowType: text('flow_type'), // 'scrape' | 'action' | null
  stepDelayMs: integer('step_delay_ms'), // ms between steps; null = default 1000ms; 0 = no delay
  // ── Deduplication (task 1.3) ───────────────────────────────────────────────
  dedupKeyField: text('dedup_key_field'),   // e.g. 'user_id', 'post_id' — the input field that makes an execution unique
  dedupBreakType: text('dedup_break_type'), // 'hard' | 'soft' | null — null = no dedup
  dedupIntervalHours: integer('dedup_interval_hours'), // for soft break: minimum hours between repeats
  dedupBlockMessage: text('dedup_block_message'), // message returned to agent when blocked (should route to alternative action)
  // ── Table metadata (task 6.4) ──────────────────────────────────────────────
  readsFrom: text('reads_from'),   // table name this flow reads data from (null = none)
  writesTo: text('writes_to'),     // table name this flow writes data to (null = none)
  updatesFields: text('updates_fields'), // JSON: string[] — field names written by this flow
  // ── Human approval queue (task 5.3) ───────────────────────────────────────
  requiresApproval: integer('requires_approval', { mode: 'boolean' }).notNull().default(false),
  // ── Infeasibility flag (Feature 2.1) ───────────────────────────────────────
  infeasible: integer('infeasible', { mode: 'boolean' }).notNull().default(false),
  infeasibleReason: text('infeasible_reason'),
  // ── Human review requirement (Feature 3.6) ────────────────────────────────
  requiresHumanReview: integer('requires_human_review', { mode: 'boolean' }).notNull().default(false),
  // ── QA contract (Flow Tester Plan) ────────────────────────────────────────
  // Plain-English description of what a successful output looks like.
  // Used by the QA validation pass after flow generation and the inline tester.
  expectedOutput: text('expected_output'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ── pendingHumanReviews table REMOVED (OPERATION CONVERGENCE Task 4.5)
// The old __human_review__ flow step + resumeFromReview machinery were removed.
// New approval happens via actionLog. Migration 0011 drops the table.

export const toneEdits = sqliteTable('tone_edits', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  reviewId: text('review_id').notNull(),
  flowName: text('flow_name').notNull(),
  context: text('context').notNull().default(''),
  agentDraft: text('agent_draft').notNull(),
  humanFinal: text('human_final').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});
