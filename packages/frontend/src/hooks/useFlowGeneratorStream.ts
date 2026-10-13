/**
 * useFlowGeneratorStream
 *
 * Owns all SSE stream state for the flow generator:
 *   - AbortController / cancelRef
 *   - autoSentRef (React Strict Mode double-mount guard)
 *   - event accumulation (chatItems, conversationHistory, previewSteps, …)
 *   - loading status
 *
 * The component renders from the values returned here and delegates
 * all stream mutations to `sendMessages` / `cancel`.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api/client.js';
import type { FlowInput } from '../types/index.js';

// ── Public types (also re-exported from FlowGenerator for backwards-compat) ──

export interface GeneratorMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface InputRequestField {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
}

// ── Stream event types ────────────────────────────────────────────────────────

export type StreamEvent =
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; tool: string; displayText: string }
  | { type: 'tool_result'; tool: string; summary: string }
  | { type: 'screenshot'; url: string }
  | { type: 'flow_update'; steps: Array<{ label: string; toolName: string }>; name?: string; description?: string }
  | { type: 'complete'; flow: FlowInput; explanation?: string }
  | { type: 'reply'; content: string }
  | { type: 'error'; message: string }
  | { type: 'fatal_error'; message: string }
  | { type: 'input_request'; fields: InputRequestField[] }
  | { type: 'research_summary'; text: string }
  | { type: 'session_facts'; facts: string[] }
  | { type: 'token_usage'; inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'done' }
  // ── Explorer phase events ──────────────────────────────────────────────────
  | { type: 'explorer_start' }
  | { type: 'explorer_thinking'; text: string }
  | { type: 'explorer_tool_call'; tool: string; displayText: string }
  | { type: 'explorer_tool_result'; tool: string; summary: string; ok: boolean }
  | { type: 'explorer_complete'; success: boolean; summary: string }
  | { type: 'builder_start' };

// ── Chat panel item types ─────────────────────────────────────────────────────

export type ChatItem =
  | { kind: 'user'; text: string; autoInitiated?: boolean }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; tool: string; displayText: string }
  | { kind: 'tool_result'; tool: string; summary: string }
  | { kind: 'screenshot'; url: string }
  | { kind: 'reply'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'fatal_error'; text: string }
  | { kind: 'research_summary'; text: string }
  | { kind: 'input_request'; fields: InputRequestField[]; submitted: boolean; id: string };

// ── Explorer log item types ───────────────────────────────────────────────────

export type ExplorerLogItem =
  | { kind: 'explorer_thinking'; text: string }
  | { kind: 'explorer_tool_call'; tool: string; displayText: string }
  | { kind: 'explorer_tool_result'; tool: string; summary: string; ok: boolean }
  | { kind: 'explorer_complete'; success: boolean; summary: string };

export type ExplorerPhase = 'idle' | 'exploring' | 'building' | 'done';

// ── Saved-draft shape (mirrors session-draft.ts) ──────────────────────────────

export interface SavedDraft {
  conversationHistory: GeneratorMessage[];
  previewSteps: Array<{ label: string; toolName: string }>;
  previewName: string;
  previewDesc: string;
  completedFlow: FlowInput | null;
  savedAt?: string;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface UseFlowGeneratorStreamOptions {
  agentId: string;
  confirmOnFlow: boolean;
  onFlow: (definition: FlowInput) => void;
  /** When true, auto-sends `initialMessages` once on mount. */
  autoSend: boolean;
  /**
   * Draft restored from localStorage on mount. When set, auto-send is
   * suppressed (conversation is already populated) and state is seeded
   * from the draft.
   */
  savedDraft: SavedDraft | null;
  initialMessages?: GeneratorMessage[];
  /** When set, passes flow type to the backend so it can use a type-specific system prompt. */
  flowType?: 'scrape' | 'action';
  /** Facts from previous flow builds in this session — passed to backend on each request. */
  initialSessionFacts?: string[];
  /** Pre-confirmed selectors from Quick Build form — skips the explorer entirely on first turn. */
  seedContext?: { pageUrl: string; feedSelector?: string; postCardSelector?: string; expandSelector?: string; notes?: string };
}

export interface UseFlowGeneratorStreamResult {
  // ── Accumulated stream state ──────────────────────────────────────────────
  loading: boolean;
  chatItems: ChatItem[];
  conversationHistory: GeneratorMessage[];
  previewSteps: Array<{ label: string; toolName: string }>;
  previewName: string;
  previewDesc: string;
  completedFlow: FlowInput | null;
  pendingInputId: string | null;
  sessionFacts: string[];
  tokenUsage: TokenUsage | null;
  // ── Explorer phase state ──────────────────────────────────────────────────
  explorerLog: ExplorerLogItem[];
  explorerPhase: ExplorerPhase;

  // ── Setters exposed so the component can mutate state outside of the stream
  //    (e.g. user sends a message, applies the flow, discards, repulls, etc.) ──
  setChatItems: React.Dispatch<React.SetStateAction<ChatItem[]>>;
  setConversationHistory: React.Dispatch<React.SetStateAction<GeneratorMessage[]>>;
  setPreviewSteps: React.Dispatch<React.SetStateAction<Array<{ label: string; toolName: string }>>>;
  setCompletedFlow: React.Dispatch<React.SetStateAction<FlowInput | null>>;
  setPendingInputId: React.Dispatch<React.SetStateAction<string | null>>;
  setSessionFacts: React.Dispatch<React.SetStateAction<string[]>>;

  // ── Actions ───────────────────────────────────────────────────────────────
  /** Append a single item to the chat log. */
  appendItem: (item: ChatItem) => void;
  /** Start a new SSE stream with the given conversation history. */
  sendMessages: (msgs: GeneratorMessage[]) => Promise<void>;
  /** Cancel the current in-flight SSE stream (no-op if none). */
  cancel: () => void;
}

export function useFlowGeneratorStream({
  agentId,
  confirmOnFlow,
  onFlow,
  autoSend,
  savedDraft,
  initialMessages,
  flowType,
  initialSessionFacts,
  seedContext,
}: UseFlowGeneratorStreamOptions): UseFlowGeneratorStreamResult {
  // ── State seeded from draft if available ─────────────────────────────────

  const [chatItems, setChatItems] = useState<ChatItem[]>(() => {
    // When restoring a draft, inject a "resumed session" notice as the first item
    if (savedDraft && savedDraft.conversationHistory.length > 0) {
      const ago = savedDraft.savedAt
        ? (() => {
            const diff = Date.now() - new Date(savedDraft.savedAt).getTime();
            if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
            if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
            return `${Math.round(diff / 86_400_000)}d ago`;
          })()
        : 'earlier';
      return [{
        kind: 'reply' as const,
        text: `↩ Resumed previous session (saved ${ago}). Your conversation history has been restored — keep chatting to refine, or click "Apply Flow" / "Edit in Editor" if the flow looks good.`,
      }];
    }
    return [];
  });

  const [loading, setLoading] = useState(false);
  const [pendingInputId, setPendingInputId] = useState<string | null>(null);
  const [sessionFacts, setSessionFacts] = useState<string[]>(initialSessionFacts ?? []);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [explorerLog, setExplorerLog] = useState<ExplorerLogItem[]>([]);
  const [explorerPhase, setExplorerPhase] = useState<ExplorerPhase>('idle');

  const [conversationHistory, setConversationHistory] = useState<GeneratorMessage[]>(
    savedDraft?.conversationHistory ?? initialMessages ?? [],
  );

  const [previewSteps, setPreviewSteps] = useState<Array<{ label: string; toolName: string }>>(
    savedDraft?.previewSteps ?? [],
  );
  const [previewName, setPreviewName] = useState<string>(savedDraft?.previewName ?? '');
  const [previewDesc, setPreviewDesc] = useState<string>(savedDraft?.previewDesc ?? '');
  const [completedFlow, setCompletedFlow] = useState<FlowInput | null>(savedDraft?.completedFlow ?? null);

  // ── Refs ──────────────────────────────────────────────────────────────────

  /** Always up-to-date mirror of sessionFacts for use inside sendMessages callback. */
  const sessionFactsRef = useRef<string[]>(initialSessionFacts ?? []);
  // Keep ref in sync whenever state updates
  sessionFactsRef.current = sessionFacts;

  /**
   * Holds the cancel function for the current in-flight SSE stream.
   * Stored in a ref so the cleanup effect can always reach the latest value
   * without stale-closure problems.
   */
  const cancelRef = useRef<(() => void) | null>(null);

  /**
   * Guards against React Strict Mode's deliberate unmount→remount cycle.
   * Without this flag, the fake-unmount cancels the stream and the flag
   * stays `true` on the remount — meaning auto-send never re-fires and
   * `loading` stays `true` forever. Resetting it on cleanup lets the
   * real remount re-send correctly.
   */
  const autoSentRef = useRef(false);

  // ── Strict Mode / unmount cleanup ─────────────────────────────────────────
  // React Strict Mode deliberately unmounts→remounts every component in dev.
  // We must:
  //   1. Cancel the in-flight SSE stream (otherwise it leaks)
  //   2. Reset autoSentRef so the real mount can re-fire the auto-send
  //   3. Clear chatItems so the real mount starts with a blank slate
  //      (state is PRESERVED across the Strict Mode cycle, so without this
  //       the second mount sees [user_msg] already in chatItems and auto-send
  //       appends a second copy → duplicate green bubble in the chat)
  useEffect(() => {
    return () => {
      cancelRef.current?.();
      autoSentRef.current = false;
      setChatItems([]);
    };
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const appendItem = useCallback((item: ChatItem) => {
    setChatItems((prev) => [...prev, item]);
  }, []);

  // ── Main stream sender ────────────────────────────────────────────────────

  const sendMessages = useCallback(async (msgs: GeneratorMessage[]) => {
    setLoading(true);
    // Intentionally do NOT clear completedFlow here — post-submit rename messages
    // would wipe the preview. completedFlow is only cleared by explicit Discard or
    // when a new flow starts.

    const { cancel } = api.generateFlowStream(
      agentId,
      msgs.map((m) => ({ role: m.role, content: m.content })),
      (raw) => {
        const event = raw as StreamEvent;
        switch (event.type) {
          case 'thinking':
            appendItem({ kind: 'thinking', text: event.text });
            break;
          case 'tool_call':
            appendItem({ kind: 'tool_call', tool: event.tool, displayText: event.displayText });
            break;
          case 'tool_result':
            appendItem({ kind: 'tool_result', tool: event.tool, summary: event.summary });
            break;
          case 'screenshot':
            appendItem({ kind: 'screenshot', url: event.url });
            break;
          case 'research_summary':
            // TASK 8.1 — show what was discovered during page analysis
            appendItem({ kind: 'research_summary', text: event.text });
            break;
          case 'session_facts':
            // TASK 8.3 — update running facts list; parent persists to localStorage
            setSessionFacts(event.facts);
            break;
          case 'token_usage':
            // TASK 8.4 — live cost counter
            setTokenUsage({ inputTokens: event.inputTokens, outputTokens: event.outputTokens, estimatedCostUsd: event.estimatedCostUsd });
            break;
          case 'fatal_error':
            // TASK 8.4 — credit exhaustion or other fatal stop — shown as an unmissable banner
            appendItem({ kind: 'fatal_error', text: event.message });
            setLoading(false);
            break;
          case 'flow_update':
            if (event.steps) setPreviewSteps(event.steps);
            if (event.name) {
              setPreviewName(event.name);
              // Also update completedFlow so Apply/Edit use the new name
              setCompletedFlow((prev) => prev ? { ...prev, name: event.name } : prev);
            }
            if (event.description) {
              setPreviewDesc(event.description);
              setCompletedFlow((prev) => prev ? { ...prev, description: event.description } : prev);
            }
            break;
          case 'complete': {
            setPreviewSteps(
              (event.flow.steps ?? []).map((s: { label?: string; toolId?: string }) => ({
                label: s.label ?? '(step)',
                toolName: s.toolId ?? '',
              })),
            );
            if (confirmOnFlow) {
              setCompletedFlow(event.flow);
              // Do NOT add event.explanation here — the backend already emitted it as a
              // thinking event before submit_flow, so adding it again causes a duplicate.
              // The agent sends a proper reply event right after submit_flow returns.
              appendItem({ kind: 'reply', text: 'Flow is ready! Click "Apply Flow" to save it, or keep chatting to refine.' });
            } else {
              onFlow(event.flow);
            }
            setLoading(false);
            break;
          }
          case 'input_request': {
            const formId = crypto.randomUUID();
            setPendingInputId(formId);
            setChatItems((prev) => [
              ...prev,
              { kind: 'input_request', fields: event.fields, submitted: false, id: formId },
            ]);
            setLoading(false);
            break;
          }
          case 'reply':
            if (event.content) appendItem({ kind: 'reply', text: event.content });
            // Update conversation history with the AI reply
            setConversationHistory((prev) => [
              ...prev,
              { role: 'assistant', content: event.content },
            ]);
            setLoading(false);
            break;
          case 'error':
            appendItem({ kind: 'error', text: event.message });
            setLoading(false);
            break;
          case 'done':
            setLoading(false);
            break;
          // ── Explorer phase events ────────────────────────────────────────
          case 'explorer_start':
            setExplorerPhase('exploring');
            setExplorerLog([]);
            break;
          case 'explorer_thinking':
            setExplorerLog((prev) => [...prev, { kind: 'explorer_thinking', text: event.text }]);
            break;
          case 'explorer_tool_call':
            setExplorerLog((prev) => [...prev, { kind: 'explorer_tool_call', tool: event.tool, displayText: event.displayText }]);
            break;
          case 'explorer_tool_result':
            setExplorerLog((prev) => [...prev, { kind: 'explorer_tool_result', tool: event.tool, summary: event.summary, ok: event.ok }]);
            break;
          case 'explorer_complete':
            setExplorerLog((prev) => [...prev, { kind: 'explorer_complete', success: event.success, summary: event.summary }]);
            setExplorerPhase('building');
            break;
          case 'builder_start':
            setExplorerPhase('building');
            break;
        }
      },
      flowType,
      sessionFactsRef.current.length > 0 ? sessionFactsRef.current : undefined,
      seedContext,
    );

    cancelRef.current = cancel;
  }, [agentId, appendItem, confirmOnFlow, onFlow]);

  // ── Auto-send on mount ────────────────────────────────────────────────────
  // Skip if a draft was restored — conversation is already populated and
  // re-sending would restart the whole flow from scratch.
  useEffect(() => {
    if (autoSend && !autoSentRef.current && !savedDraft && initialMessages && initialMessages.length > 0) {
      const last = initialMessages[initialMessages.length - 1];
      if (last.role === 'user') {
        autoSentRef.current = true;
        appendItem({ kind: 'user', text: last.content, autoInitiated: true });
        void sendMessages(initialMessages);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Cancel helper (stable reference) ─────────────────────────────────────
  const cancel = useCallback(() => {
    cancelRef.current?.();
  }, []);

  return {
    loading,
    chatItems,
    setChatItems,
    conversationHistory,
    setConversationHistory,
    previewSteps,
    setPreviewSteps,
    previewName,
    previewDesc,
    completedFlow,
    setCompletedFlow,
    pendingInputId,
    setPendingInputId,
    sessionFacts,
    setSessionFacts,
    tokenUsage,
    explorerLog,
    explorerPhase,
    appendItem,
    sendMessages,
    cancel,
  };
}
