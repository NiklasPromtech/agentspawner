/**
 * useApiToolDiscoveryStream
 *
 * Manages the SSE stream state for the API Tool Discovery agent.
 * Pattern mirrors useFlowGeneratorStream.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api/client.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface DiscoveryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ProposedTool {
  name: string;
  description: string;
  httpMethod: string;
  endpointPath: string;
  whatItReturns: string;
  exampleUsage: string;
  /** UI-only state: 'pending' | 'approved' | 'denied' */
  status: 'pending' | 'approved' | 'denied';
}

export interface BuiltTool {
  toolId: string;
  name: string;
  description: string;
  inputSchema: string;
  enabled: boolean;
}

// ── Stream event types ───────────────────────────────────────────────────────

export type DiscoveryStreamEvent =
  | { type: 'thinking'; text: string }
  | { type: 'tools_proposed'; tools: Array<Omit<ProposedTool, 'status'>> }
  | { type: 'tool_built'; toolId: string; name: string; description: string; inputSchema: string }
  | { type: 'tool_test_result'; toolId: string; ok: boolean; result?: unknown; error?: string; durationMs: number; rateLimitInfo?: { limit?: number; remaining?: number; retryAfterSeconds?: number } }
  | { type: 'tool_enabled'; toolId: string }
  | { type: 'tool_deleted'; toolId: string }
  | { type: 'rate_limit_wait'; seconds: number; reason: string }
  | { type: 'secret_stored'; key: string }
  | { type: 'reply'; content: string }
  | { type: 'error'; message: string }
  | { type: 'fatal_error'; message: string }
  | { type: 'token_usage'; inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'done' };

// ── Chat panel item types ────────────────────────────────────────────────────

export type DiscoveryChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'reply'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'fatal_error'; text: string }
  | { kind: 'proposals'; tools: ProposedTool[] }
  | { kind: 'tool_built'; toolId: string; name: string; description: string; inputSchema: string }
  | { kind: 'tool_test_result'; toolId: string; ok: boolean; result?: unknown; error?: string; durationMs: number }
  | { kind: 'tool_enabled'; toolId: string }
  | { kind: 'tool_deleted'; toolId: string }
  | { kind: 'rate_limit_wait'; seconds: number; reason: string }
  | { kind: 'secret_stored'; key: string };

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UseApiToolDiscoveryStreamOptions {
  agentId: string;
  autoSend: boolean;
  initialMessages?: DiscoveryMessage[];
}

export interface UseApiToolDiscoveryStreamResult {
  loading: boolean;
  chatItems: DiscoveryChatItem[];
  conversationHistory: DiscoveryMessage[];
  proposals: ProposedTool[];
  builtTools: BuiltTool[];
  tokenUsage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number } | null;

  setProposals: React.Dispatch<React.SetStateAction<ProposedTool[]>>;
  appendItem: (item: DiscoveryChatItem) => void;
  sendMessages: (msgs: DiscoveryMessage[]) => Promise<void>;
  setConversationHistory: React.Dispatch<React.SetStateAction<DiscoveryMessage[]>>;
  cancel: () => void;
}

export function useApiToolDiscoveryStream({
  agentId,
  autoSend,
  initialMessages,
}: UseApiToolDiscoveryStreamOptions): UseApiToolDiscoveryStreamResult {
  const [chatItems, setChatItems] = useState<DiscoveryChatItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [proposals, setProposals] = useState<ProposedTool[]>([]);
  const [builtTools, setBuiltTools] = useState<BuiltTool[]>([]);
  const [tokenUsage, setTokenUsage] = useState<{ inputTokens: number; outputTokens: number; estimatedCostUsd: number } | null>(null);
  const [conversationHistory, setConversationHistory] = useState<DiscoveryMessage[]>(
    initialMessages ?? [],
  );

  const cancelRef = useRef<(() => void) | null>(null);
  const autoSentRef = useRef(false);

  // Strict Mode cleanup
  useEffect(() => {
    return () => {
      cancelRef.current?.();
      autoSentRef.current = false;
      setChatItems([]);
    };
  }, []);

  const appendItem = useCallback((item: DiscoveryChatItem) => {
    setChatItems((prev) => [...prev, item]);
  }, []);

  // ── Main stream sender ──────────────────────────────────────────────────

  const sendMessages = useCallback(async (msgs: DiscoveryMessage[]) => {
    setLoading(true);

    const { cancel: cancelStream } = api.discoverApiToolsStream(
      agentId,
      msgs.map((m) => ({ role: m.role, content: m.content })),
      (raw) => {
        const event = raw as DiscoveryStreamEvent;
        switch (event.type) {
          case 'thinking':
            appendItem({ kind: 'thinking', text: event.text });
            break;
          case 'tools_proposed':
            {
              const withStatus: ProposedTool[] = event.tools.map((t) => ({ ...t, status: 'pending' as const }));
              setProposals(withStatus);
              appendItem({ kind: 'proposals', tools: withStatus });
            }
            break;
          case 'tool_built':
            setBuiltTools((prev) => [
              ...prev.filter((t) => t.toolId !== event.toolId),
              { toolId: event.toolId, name: event.name, description: event.description, inputSchema: event.inputSchema, enabled: false },
            ]);
            appendItem({ kind: 'tool_built', toolId: event.toolId, name: event.name, description: event.description, inputSchema: event.inputSchema });
            break;
          case 'tool_test_result':
            appendItem({ kind: 'tool_test_result', toolId: event.toolId, ok: event.ok, result: event.result, error: event.error, durationMs: event.durationMs });
            break;
          case 'tool_enabled':
            setBuiltTools((prev) => prev.map((t) => t.toolId === event.toolId ? { ...t, enabled: true } : t));
            appendItem({ kind: 'tool_enabled', toolId: event.toolId });
            break;
          case 'tool_deleted':
            setBuiltTools((prev) => prev.filter((t) => t.toolId !== event.toolId));
            appendItem({ kind: 'tool_deleted', toolId: event.toolId });
            break;
          case 'rate_limit_wait':
            appendItem({ kind: 'rate_limit_wait', seconds: event.seconds, reason: event.reason });
            break;
          case 'secret_stored':
            appendItem({ kind: 'secret_stored', key: event.key });
            break;
          case 'token_usage':
            setTokenUsage({ inputTokens: event.inputTokens, outputTokens: event.outputTokens, estimatedCostUsd: event.estimatedCostUsd });
            break;
          case 'reply':
            if (event.content) {
              appendItem({ kind: 'reply', text: event.content });
              setConversationHistory((prev) => [...prev, { role: 'assistant', content: event.content }]);
            }
            setLoading(false);
            break;
          case 'error':
            appendItem({ kind: 'error', text: event.message });
            setLoading(false);
            break;
          case 'fatal_error':
            appendItem({ kind: 'fatal_error', text: event.message });
            setLoading(false);
            break;
          case 'done':
            setLoading(false);
            break;
        }
      },
    );

    cancelRef.current = cancelStream;
  }, [agentId, appendItem]);

  // ── Auto-send on mount ──────────────────────────────────────────────────

  useEffect(() => {
    if (autoSend && !autoSentRef.current && initialMessages && initialMessages.length > 0) {
      const last = initialMessages[initialMessages.length - 1];
      if (last.role === 'user') {
        autoSentRef.current = true;
        appendItem({ kind: 'user', text: last.content });
        void sendMessages(initialMessages);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = useCallback(() => {
    cancelRef.current?.();
    setLoading(false);
  }, []);

  return {
    loading,
    chatItems,
    conversationHistory,
    proposals,
    builtTools,
    tokenUsage,
    setProposals,
    appendItem,
    sendMessages,
    setConversationHistory,
    cancel,
  };
}
