import type { Agent, Tool, Run, Message, Table, Row, Schedule, Flow, FlowInput, FlowRun, FlowTestResult, MemoryEntry, SetupGenerateResult, RecordEvent, Goal, AnalyticsSummary, ApiTool, AgentSecret, RunExplanation, AgentDashboard } from '../types/index.js';

const BASE = 'http://localhost:3001';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const hasBody = options?.body != null;
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...((options?.headers as Record<string, string>) ?? {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; message?: string };
    throw new Error(err.error ?? err.message ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// Agents
export const api = {
  // Agents
  getAgents: () => request<Agent[]>('/agents'),
  getAgent: (id: string) => request<Agent>(`/agents/${id}`),
  createAgent: (data: Partial<Agent> & { apiKey?: string; copyKeyFromAgentId?: string }) =>
    request<Agent>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: string, data: Partial<Agent> & { apiKey?: string; telegramKey?: string }) =>
    request<Agent>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  patchAgent: (id: string, data: { profileBlob?: string | null }) =>
    request<Agent>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAgent: (id: string) =>
    request<{ success: boolean }>(`/agents/${id}`, { method: 'DELETE' }),

  // Tools
  getTools: (agentId: string) => request<Tool[]>(`/agents/${agentId}/tools`),
  getTool: (agentId: string, toolId: string) =>
    request<Tool>(`/agents/${agentId}/tools/${toolId}`),
  createTool: (agentId: string, data: Partial<Tool>) =>
    request<Tool>(`/agents/${agentId}/tools`, { method: 'POST', body: JSON.stringify(data) }),
  updateTool: (agentId: string, toolId: string, data: Partial<Tool>) =>
    request<Tool>(`/agents/${agentId}/tools/${toolId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteTool: (agentId: string, toolId: string) =>
    request<{ success: boolean }>(`/agents/${agentId}/tools/${toolId}`, { method: 'DELETE' }),
  testTool: (agentId: string, toolId: string, input: Record<string, unknown>) =>
    request<{ ok: boolean; result?: string; error?: string; durationMs: number }>(
      `/agents/${agentId}/tools/${toolId}/test`,
      { method: 'POST', body: JSON.stringify({ input }) },
    ),

  // Runs
  getRuns: (agentId: string) => request<Run[]>(`/agents/${agentId}/runs`),
  createRun: (agentId: string, input: string) =>
    request<{ runId: string }>(`/agents/${agentId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    }),
  stopRun: (runId: string) =>
    request<{ success: boolean }>(`/runs/${runId}/stop`, { method: 'POST' }),
  wakeUp: (agentId: string, budgetUsdPerHour?: number, recentMessages?: Array<{ role: 'user' | 'assistant'; content: string }>) =>
    request<{ runId: string }>(`/agents/${agentId}/wake-up`, {
      method: 'POST',
      body: JSON.stringify({ budgetUsdPerHour: budgetUsdPerHour ?? 0, recentMessages }),
    }),
  getAutonomousStatus: (agentId: string) =>
    request<{ latestRun: import('../types/index.js').Run | null; currentTask: string | null; plan: string | null; statusUpdatedAt: string | null }>(`/agents/${agentId}/autonomous-status`),
  // OPERATION CONVERGENCE Task 10 — aggregated dashboard endpoint
  getDashboard: (agentId: string) =>
    request<AgentDashboard>(`/agents/${agentId}/dashboard`),

  // Messages
  getMessages: (runId: string) => request<Message[]>(`/runs/${runId}/messages`),
  getConversation: (agentId: string) => request<Message[]>(`/agents/${agentId}/conversation`),

  // Tables
  getTables: (agentId: string) => request<Table[]>(`/agents/${agentId}/tables`),
  createTable: (agentId: string, data: { name: string; columns: string }) =>
    request<Table>(`/agents/${agentId}/tables`, { method: 'POST', body: JSON.stringify(data) }),
  deleteTable: (agentId: string, tableId: string) =>
    request<{ success: boolean }>(`/agents/${agentId}/tables/${tableId}`, { method: 'DELETE' }),
  getRows: (tableId: string) => request<Row[]>(`/tables/${tableId}/rows`),
  deleteRow: (tableId: string, rowId: string) =>
    request<{ success: boolean }>(`/tables/${tableId}/rows/${rowId}`, { method: 'DELETE' }),

  // Schedules
  getSchedules: (agentId: string) => request<Schedule[]>(`/agents/${agentId}/schedules`),
  createSchedule: (agentId: string, data: Partial<Schedule>) =>
    request<Schedule>(`/agents/${agentId}/schedules`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateSchedule: (agentId: string, scheduleId: string, data: Partial<Schedule>) =>
    request<Schedule>(`/agents/${agentId}/schedules/${scheduleId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteSchedule: (agentId: string, scheduleId: string) =>
    request<{ success: boolean }>(`/agents/${agentId}/schedules/${scheduleId}`, {
      method: 'DELETE',
    }),

  // Flows
  getFlows: (agentId: string) => request<Flow[]>(`/agents/${agentId}/flows`),
  getFlow: (agentId: string, flowId: string) => request<Flow>(`/agents/${agentId}/flows/${flowId}`),
  createFlow: (agentId: string, data: FlowInput) =>
    request<Flow>(`/agents/${agentId}/flows`, { method: 'POST', body: JSON.stringify(data) }),
  updateFlow: (agentId: string, flowId: string, data: FlowInput) =>
    request<Flow>(`/agents/${agentId}/flows/${flowId}`, { method: 'PUT', body: JSON.stringify(data) }),
  copyFlow: (agentId: string, flowId: string) =>
    request<Flow>(`/agents/${agentId}/flows/${flowId}/copy`, { method: 'POST' }),
  deleteFlow: (agentId: string, flowId: string) =>
    request<{ success: boolean }>(`/agents/${agentId}/flows/${flowId}`, { method: 'DELETE' }),
  pinFlow: (agentId: string, flowId: string, pinned: boolean) =>
    request<Flow>(`/agents/${agentId}/flows/${flowId}/pin`, { method: 'PATCH', body: JSON.stringify({ pinned }) }),
  markFlowInfeasible: (agentId: string, flowId: string, infeasible: boolean, infeasibleReason?: string | null) =>
    request<Flow>(`/agents/${agentId}/flows/${flowId}/infeasible`, { method: 'PATCH', body: JSON.stringify({ infeasible, infeasibleReason: infeasibleReason ?? null }) }),
  getFlowRuns: (agentId: string, flowId?: string) =>
    request<FlowRun[]>(`/agents/${agentId}/flow-runs${flowId ? `?flow_id=${flowId}` : ''}`),
  getRunFlowRuns: (runId: string) =>
    request<FlowRun[]>(`/runs/${runId}/flow-runs`),
  explainRun: (runId: string) =>
    request<RunExplanation>(`/runs/${runId}/explain`),
  testFlow: (agentId: string, flowId: string, input: Record<string, unknown>) =>
    request<FlowTestResult>(`/agents/${agentId}/flows/${flowId}/test`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    }),
  testFlowInline: (
    agentId: string,
    steps: import('../types/index.js').FlowStep[],
    inputSchema: string,
    returnStepId: string | null | undefined,
    returnSteps: string | null | undefined,
    input: Record<string, unknown>,
    resultMessage?: string | null,
  ) =>
    request<FlowTestResult>(`/agents/${agentId}/flows/test`, {
      method: 'POST',
      body: JSON.stringify({ steps, inputSchema, returnStepId, returnSteps, input, resultMessage }),
    }),

  // Flow generator (streaming SSE via fetch)
  generateFlowStream: (
    agentId: string,
    messages: { role: 'user' | 'assistant'; content: unknown }[],
    onEvent: (event: Record<string, unknown>) => void,
    flowType?: 'scrape' | 'action',
    sessionFacts?: string[],
    seedContext?: { pageUrl: string; feedSelector?: string; postCardSelector?: string; expandSelector?: string; notes?: string },
  ): { cancel: () => void; done: Promise<void> } => {
    const controller = new AbortController();
    const done = (async () => {
      let receivedDone = false;

      const res = await fetch(`${BASE}/agents/${agentId}/flows/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          ...(flowType ? { flowType } : {}),
          ...(sessionFacts && sessionFacts.length > 0 ? { sessionFacts } : {}),
          ...(seedContext ? { seedContext } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        onEvent({ type: 'error', message: `Server error ${res.status} — is the backend running?` });
        return;
      }
      if (!res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if (ev.type === 'done') receivedDone = true;
            onEvent(ev);
          } catch { /* ignore malformed lines */ }
        }
      }

      // Stream ended without a 'done' event — emit one so loading state is cleared.
      // This happens when the backend closes the connection early (e.g. client
      // disconnect detected) without writing a final done event.
      if (!receivedDone) {
        onEvent({ type: 'done' });
      }
    })().catch((err: unknown) => {
      // AbortError = intentional cancel (user navigated away) — stay silent
      if (err instanceof Error && err.name === 'AbortError') return;
      // Anything else (network down, backend not running, etc.) — surface it
      onEvent({ type: 'error', message: 'Could not reach the backend. Make sure the server is running.' });
    });
    return { cancel: () => controller.abort(), done };
  },

  // Setup
  fetchCompany: (agentId: string, url: string) =>
    request<{ summary: string; name?: string }>(`/agents/${agentId}/setup/fetch-company`, { method: 'POST', body: JSON.stringify({ url }) }),
  generateSetup: (agentId: string, data: { roleTitle: string; companyContext: string; jobDescription: string }) =>
    request<SetupGenerateResult>(`/agents/${agentId}/setup/generate`, { method: 'POST', body: JSON.stringify(data) }),
  amendSetup: (agentId: string, data: { currentPrompt: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> }) =>
    request<{ proposedPrompt: string; explanation: string }>(`/agents/${agentId}/setup/amend`, { method: 'POST', body: JSON.stringify(data) }),
  parsePrompt: (agentId: string) =>
    request<{ profileBlob: unknown }>(`/agents/${agentId}/setup/parse-prompt`, { method: 'POST' }),

  // Conversational onboarding — pass { apiKey } OR { agentId } to borrow an existing agent's key
  setupConverse: (
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    auth: { apiKey: string } | { agentId: string },
  ) =>
    request<{
      done: boolean;
      reply: string;
      config?: {
        name: string;
        systemPrompt: string;
        goals?: { type: string; title: string; description: string; priority: number }[];
      };
    }>('/setup/converse', { method: 'POST', body: JSON.stringify({ messages, ...auth }) }),

  // Plan flows — Sonnet proposes atomic flow set for a new agent
  planFlows: (
    auth: { apiKey: string } | { agentId: string },
    data: {
      systemPrompt: string;
      description: string;
      brief_flows?: Array<{ name: string; type: 'scrape' | 'action'; description: string; purpose: string }>;
      feedback?: string;
    },
  ) =>
    request<{
      flows: Array<{ name: string; type: 'scrape' | 'action'; description: string; purpose: string }>;
    }>('/setup/plan-flows', { method: 'POST', body: JSON.stringify({ ...auth, ...data }) }),

  // Recording
  startRecording: (url: string) => request<{ ok: boolean }>('/recording/start', { method: 'POST', body: JSON.stringify({ url }) }),
  getRecordingEvents: () => request<{ events: RecordEvent[]; done: boolean }>('/recording/events'),
  stopRecording: () => request<{ ok: boolean }>('/recording/stop', { method: 'POST' }),
  cancelRecording: () => request<{ ok: boolean }>('/recording', { method: 'DELETE' }),

  // Extension
  getExtensionStatus: () => request<{
    connected: boolean;
    lastSeenAt: string | null;
    disconnectedAt: string | null;
    connectedAt: string | null;
    pendingCalls: number;
  }>('/extension/status'),

  // Generate tool
  generateTool: (agentId: string, prompt: string, toolType: string, existingCode?: string) =>
    request<Partial<Tool>>('/generate-tool', {
      method: 'POST',
      body: JSON.stringify({ agentId, prompt, toolType, ...(existingCode ? { existingCode } : {}) }),
    }),

  // Goals
  getGoals: (agentId: string) => request<Goal[]>(`/agents/${agentId}/goals`),
  createGoal: (agentId: string, data: Partial<Goal> & { title: string }) =>
    request<Goal>(`/agents/${agentId}/goals`, { method: 'POST', body: JSON.stringify(data) }),
  updateGoal: (agentId: string, goalId: string, data: Partial<Goal>) =>
    request<Goal>(`/agents/${agentId}/goals/${goalId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteGoal: (agentId: string, goalId: string) =>
    request<{ success: boolean }>(`/agents/${agentId}/goals/${goalId}`, { method: 'DELETE' }),

  // Tone guide
  getToneStatus: (agentId: string) =>
    request<{
      toneGuide: string[];
      toneGuideUpdatedAt: string | null;
      editCount: number;
      lastError: string | null;
      lastErrorAt: string | null;
    }>(`/agents/${agentId}/reviews/tone`),
  refreshAgentToneGuide: (agentId: string) =>
    request<{
      toneGuide: string[];
      toneGuideUpdatedAt: string | null;
      editCount: number;
      lastError: null;
      lastErrorAt: null;
    }>(`/agents/${agentId}/reviews/tone/refresh`, { method: 'POST' }),
  updateToneGuide: (agentId: string, toneGuide: string[]) =>
    request<{ toneGuide: string[] }>(`/agents/${agentId}/reviews/tone`, {
      method: 'PATCH',
      body: JSON.stringify({ toneGuide }),
    }),

  // Pending Actions — REMOVED: pendingActions table is dead (superseded by actionLog in KEYSTONE).
  // getActions, updateAction, deleteAction were removed in OPERATION CONVERGENCE.

  // Analytics
  getAnalytics: (agentId: string, days?: number) =>
    request<AnalyticsSummary>(`/agents/${agentId}/analytics${days ? `?days=${days}` : ''}`),
  runAudit: (agentId: string) =>
    request<{ report: string; memoryId: string; timestamp: string }>(
      `/agents/${agentId}/audit`,
      { method: 'POST' },
    ),

  // Memory
  searchMemory: (q: string, limit?: number) =>
    request<MemoryEntry[]>(`/memory/search?q=${encodeURIComponent(q)}&limit=${limit ?? 50}`),
  getRecentMemory: (limit?: number) =>
    request<MemoryEntry[]>(`/memory/recent?limit=${limit ?? 100}`),
  deleteMemoryEntry: (id: string) =>
    request<{ success: boolean }>(`/memory/${id}`, { method: 'DELETE' }),
  clearAgentMemory: (agentId: string) =>
    request<{ deleted: number }>(`/memory/agent/${agentId}`, { method: 'DELETE' }),

  // Nudge — inject a user message into a running autonomous session
  nudgeAgent: (agentId: string, message: string) =>
    request<{ queued: boolean }>(`/agents/${agentId}/nudge`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  // ── API Tools ────────────────────────────────────────────────────────────
  getApiTools: (agentId: string) =>
    request<ApiTool[]>(`/agents/${agentId}/api-tools`),
  createApiTool: (agentId: string, data: Partial<ApiTool>) =>
    request<ApiTool>(`/agents/${agentId}/api-tools`, { method: 'POST', body: JSON.stringify(data) }),
  updateApiTool: (agentId: string, toolId: string, data: Partial<ApiTool>) =>
    request<ApiTool>(`/agents/${agentId}/api-tools/${toolId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteApiTool: (agentId: string, toolId: string) =>
    request<{ success: boolean }>(`/agents/${agentId}/api-tools/${toolId}`, { method: 'DELETE' }),
  testApiTool: (agentId: string, toolId: string, input: Record<string, unknown>) =>
    request<{ ok: boolean; result?: unknown; error?: string; durationMs: number }>(
      `/agents/${agentId}/api-tools/${toolId}/test`,
      { method: 'POST', body: JSON.stringify({ input }) },
    ),
  assistApiTool: (agentId: string, opts: { prompt: string; currentCode?: string; toolName?: string; toolDescription?: string; inputSchema?: string }) =>
    request<{ code: string; inputSchema?: string }>(
      `/agents/${agentId}/api-tools/assist`,
      { method: 'POST', body: JSON.stringify(opts) },
    ),

  // API Tool Discovery (streaming SSE via fetch — same pattern as flow generator)
  discoverApiToolsStream: (
    agentId: string,
    messages: { role: 'user' | 'assistant'; content: unknown }[],
    onEvent: (event: Record<string, unknown>) => void,
  ): { cancel: () => void; done: Promise<void> } => {
    const controller = new AbortController();
    const done = (async () => {
      let receivedDone = false;
      const res = await fetch(`${BASE}/agents/${agentId}/api-tools/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
        signal: controller.signal,
      });
      if (!res.ok) {
        onEvent({ type: 'error', message: `Server error ${res.status} — is the backend running?` });
        return;
      }
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if (ev.type === 'done') receivedDone = true;
            onEvent(ev);
          } catch { /* ignore malformed lines */ }
        }
      }
      if (!receivedDone) onEvent({ type: 'done' });
    })().catch((err: unknown) => {
      if (err instanceof Error && err.name === 'AbortError') return;
      onEvent({ type: 'error', message: 'Could not reach the backend. Make sure the server is running.' });
    });
    return { cancel: () => controller.abort(), done };
  },

  // ── Agent Secrets ─────────────────────────────────────────────────────────
  getSecrets: (agentId: string) =>
    request<AgentSecret[]>(`/agents/${agentId}/secrets`),
  upsertSecret: (agentId: string, key: string, value: string) =>
    request<AgentSecret>(`/agents/${agentId}/secrets`, { method: 'POST', body: JSON.stringify({ key, value }) }),
  deleteSecret: (agentId: string, secretId: string) =>
    request<{ success: boolean }>(`/agents/${agentId}/secrets/${secretId}`, { method: 'DELETE' }),
  updateSecretRateLimit: (agentId: string, secretId: string, requestsPerMinute: number | null) =>
    request<{ id: string; key: string; requestsPerMinute: number | null }>(`/agents/${agentId}/secrets/${secretId}`, { method: 'PATCH', body: JSON.stringify({ requestsPerMinute }) }),

  // SSE
  subscribeToRun: (runId: string, onEvent: (event: import('../types/index.js').SseEvent) => void) => {
    const es = new EventSource(`${BASE}/runs/${runId}/events`);
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as import('../types/index.js').SseEvent;
        onEvent(event);
      } catch {
        // ignore
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  },
};
