export interface Agent {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  hasApiKey: boolean;
  telegramChatId: string;
  suppressionToken?: string | null;
  createdAt: string;
  updatedAt: string;
  // Tone guide (Feature 4)
  toneGuide?: string | null;
  toneGuideUpdatedAt?: string | null;
  // OPERATION CONVERGENCE: Task 7 — tone refresh error surfacing
  toneRefreshError?: string | null;
  toneRefreshErrorAt?: string | null;
  // OPERATION KEYSTONE: Task 3 — structured setup profile
  profileBlob?: string | null;         // JSON: ProfileBlob
  profileBlobUpdatedAt?: string | null;
  // OPERATION CONVERGENCE: Task 10 — activity dashboard
  status?: string | null;              // 'idle' | 'running' | 'error'
  lastActiveAt?: string | null;
}

export interface ProfileBlob {
  jobDescription: string;
  competitors: { name: string; url?: string; notes: string }[];
  tone: string[];
  allowed: string[];
  restricted: string[];
  focus: string;
  mindset: string;
}

export interface Tool {
  id: string;
  agentId: string;
  name: string;
  description: string;
  inputSchema: string; // JSON string
  toolType: 'extension' | 'web_search' | 'web_fetch' | 'local';
  code: string;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  agentId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped';
  trigger: 'manual' | 'schedule' | 'telegram' | 'autonomous';
  input: string;
  error?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  modelId?: string | null;   // T3 — which model handled this run
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  runId: string;
  role: 'user' | 'assistant' | 'tool_result';
  content: string; // JSON string
  createdAt: string;
}

export interface Table {
  id: string;
  agentId: string;
  name: string;
  columns: string; // JSON: [{name, type}]
  createdAt: string;
}

export interface Row {
  id: string;
  tableId: string;
  data: string; // JSON object
  createdAt: string;
}

export interface Schedule {
  id: string;
  agentId: string;
  cron: string;
  input: string;
  enabled: boolean;
  timezone: string;
  flowId?: string | null;
  lastRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// InputExpression, StepCondition, FlowStep, and OPERATION VANTAGE brief types are
// defined in @agentspawner/shared.  Imported for local use and re-exported so the
// rest of the frontend can keep importing from this file without path changes.
import type {
  InputExpression,
  StepCondition,
  FlowStep,
  // OPERATION VANTAGE — two-agent pipeline brief types
  ScrapeReference,
  DbReference,
  DecisionContext,
  ActionBriefAction,
  ActionBrief,
  HydratedScrapeReference,
  HydratedDbReference,
  MemoryQueryResult,
  HydratedDecisionContext,
  HydratedContext,
} from '@agentspawner/shared';
export type {
  InputExpression,
  StepCondition,
  FlowStep,
  ScrapeReference,
  DbReference,
  DecisionContext,
  ActionBriefAction,
  ActionBrief,
  HydratedScrapeReference,
  HydratedDbReference,
  MemoryQueryResult,
  HydratedDecisionContext,
  HydratedContext,
};

// ── API Tools ─────────────────────────────────────────────────────────────────

export interface ApiToolInputField {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
}

export type ApiToolType = 'script' | 'http';

export interface HttpToolConfig {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface ScriptToolConfig {
  code: string;
}

export interface ApiTool {
  id: string;
  agentId: string;
  name: string;
  description: string;
  inputSchema: string; // JSON
  type: ApiToolType;
  config: string; // JSON: HttpToolConfig | ScriptToolConfig
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSecret {
  id: string;
  key: string;
  value: string; // always '••••••••' from server
  requestsPerMinute: number | null;
  createdAt: string;
}

export interface ReturnStepConfig {
  key: string;
  stepId: string;
}

export interface Flow {
  id: string;
  agentId: string;
  name: string;
  description: string;
  inputSchema: string; // JSON string
  steps: string; // JSON: FlowStep[]
  returnStepId?: string | null;
  returnSteps?: string | null; // JSON: ReturnStepConfig[]
  reasoningModel?: string | null;
  reasoningPrompt?: string | null;
  resultMessage?: string | null;
  flowType?: 'scrape' | 'action' | null;
  pinned: boolean;
  // Deduplication (task 1.3)
  dedupKeyField?: string | null;
  dedupBreakType?: 'hard' | 'soft' | null;
  dedupIntervalHours?: number | null;
  dedupBlockMessage?: string | null;
  // Table metadata (task 6.4)
  readsFrom?: string | null;
  writesTo?: string | null;
  updatesFields?: string | null; // JSON: string[]
  // Human approval queue (task 5.3)
  requiresApproval?: boolean;
  // Infeasible flag (Feature 2.1)
  infeasible?: boolean;
  infeasibleReason?: string | null;
  // Human review requirement (Feature 3.6)
  requiresHumanReview?: boolean;
  // QA contract
  expectedOutput?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Action Log (task 1.4 + OPERATION KEYSTONE Task 1) ─────────────────────────
export interface ActionLogEntry {
  id: string;
  agentId: string;
  flowId: string;
  flowName: string;
  flowType: string;
  keyField: string;
  keyValue: string;
  input: string; // JSON
  result?: string | null;
  blocked: boolean;
  runId?: string | null;
  // OPERATION KEYSTONE: Task 1 fields
  status: 'pending_review' | 'approved' | 'approved_with_edits' | 'rejected' | 'executed' | 'failed' | 'blocked';
  blockedReason?: string | null;
  finalContent?: string | null;
  reRunCount: number;
  createdAt: string;
}

// ── Contacts (task 6.3) ─────────────────────────────────────────────────────────
export interface Contact {
  id: string;
  agentId: string;
  platform: string;
  handle: string;
  displayName?: string | null;
  notes: string;
  status: 'prospect' | 'contacted' | 'replied' | 'converted' | 'do_not_contact';
  lastAction?: string | null;
  lastActionAt?: string | null;
  lastActionInput: string; // JSON
  metadata: string; // JSON
  createdAt: string;
  updatedAt: string;
}

export interface FlowRun {
  id: string;
  flowId: string;
  flowName: string;
  agentId: string;
  runId: string | null;
  input: string;       // JSON
  output: string | null;
  evaluationPassed: boolean | null;
  evaluationReason: string | null;
  durationMs: number | null;
  success: boolean;
  error: string | null;
  createdAt: string;
  // T1–T3 transparency fields
  reasoning: string | null;
  goalId: string | null;
  modelId: string | null;
  // OPERATION KEYSTONE: Task 2 — step results always persisted on completion
  stepResults?: string | null; // JSON: Record<stepId, unknown>
}

export interface RunExplanation {
  runId: string;
  narrative: string;
  flowsCalled: string[];
  goalWorkedOn: string | null;
  modelUsed: string | null;
  flowRunCount: number;
  dbRowsWritten: number;
}

// Payload type for create/update — steps is an array (backend Zod accepts array, then serializes)
export interface FlowInput {
  name?: string;
  description?: string;
  flowType?: 'scrape' | 'action' | null;
  inputSchema?: string;
  steps?: FlowStep[];
  returnStepId?: string | null;
  returnSteps?: string | null; // JSON: ReturnStepConfig[]
  reasoningModel?: string | null;
  reasoningPrompt?: string | null;
  resultMessage?: string | null;
  // Deduplication (task 1.3)
  dedupKeyField?: string | null;
  dedupBreakType?: 'hard' | 'soft' | null;
  dedupIntervalHours?: number | null;
  dedupBlockMessage?: string | null;
  // Table metadata (task 6.4)
  readsFrom?: string | null;
  writesTo?: string | null;
  updatesFields?: string[] | null;
  // Human approval queue (task 5.3)
  requiresApproval?: boolean;
  // Infeasible flag (Feature 2.1)
  infeasible?: boolean;
  infeasibleReason?: string | null;
  // Human review requirement (Feature 3.6)
  requiresHumanReview?: boolean;
  // QA contract
  expectedOutput?: string | null;
}

export interface FlowTestResult {
  ok: boolean;
  result?: string;
  stepResults: Record<string, unknown>;
  stepTimings?: Record<string, number>;
  durationMs: number;
  error?: string;
}

export interface Goal {
  id: string;
  agentId: string;
  parentId?: string | null;
  type: 'mission' | 'objective' | 'task';
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
  priority: 1 | 2 | 3 | 4;
  dueDate?: string | null;
  notes: string;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// PendingAction interface REMOVED (OPERATION CONVERGENCE Task 4.5)
// Superseded by ActionLogEntry. The pendingActions table has been dropped.

export interface PerformanceEntry {
  id: string;
  agentId: string;
  category: string;
  action: string;
  outcome: 'success' | 'failure' | 'pending' | 'unknown';
  value: number;
  notes: string;
  metadata: string; // JSON
  runId?: string | null;
  createdAt: string;
}

export interface AnalyticsSummary {
  period: { days: number; since: string };
  runs: {
    total: number;
    completed: number;
    failed: number;
    stopped: number;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    byDay: { date: string; runs: number; cost: number }[];
  };
  performance: {
    entries: number;
    byCategory: {
      category: string;
      total: number;
      success: number;
      failure: number;
      pending: number;
      successRate: string;
    }[];
  };
  sessionJournal: {
    id: string;
    content: string;
    createdAt: string;
    metadata: Record<string, unknown>;
  }[];
}

export interface MemoryEntry {
  id: string;
  content: string;
  category: string;
  entities: string; // JSON: string[]
  sourceAgentId?: string | null;
  sourceAgentName?: string | null;
  sourceTool?: string | null;
  sourceUrl?: string | null;
  metadata: string; // JSON
  rawHash?: string | null;
  createdAt: string;
}

export interface SetupGenerateResult {
  systemPrompt: string;
  recommendedFlows: { name: string; description: string }[];
  recommendedDatabases: { name: string; description: string; columns: { name: string; type: string }[] }[];
  recommendedSchedules: { flowName: string; cron: string; label: string; input: string }[];
}

export interface RecordEvent {
  type: 'navigate' | 'click' | 'type';
  url?: string;
  selector?: string;
  text?: string;
  value?: string;
}

// HumanReview interface REMOVED (OPERATION CONVERGENCE Task 4.5)
// The pendingHumanReviews table has been dropped. New approval happens via actionLog.


// OPERATION CONVERGENCE Task 10 — aggregated dashboard data
export interface AgentDashboard {
  status: 'idle' | 'running' | 'error';
  lastActiveAt: string | null;
  latestRun: Run | null;
  currentTask: string | null;
  statusUpdatedAt: string | null;
  pendingApprovalsCount: number;
  recentActions: ActionLogEntry[];
  todayTokens: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  extensionConnected: boolean;
  extensionLastSeenAt: string | null;
}

export interface SseEvent {
  type: 'message' | 'tool_call' | 'tool_result' | 'done' | 'error' | 'open_flow_generator' | 'wake_up_context';
  role?: string;
  content?: unknown;
  toolName?: string;
  input?: unknown;
  correlationId?: string;
  result?: string;
  error?: string;
  runId?: string;
  message?: string;
  prompt?: string;
  source?: string; // e.g. 'manager', 'chat' — identifies which agent emitted this event
}
