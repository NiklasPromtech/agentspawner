/**
 * ApiToolDiscovery — conversational chat panel for discovering & building API tools.
 * Pattern mirrors FlowGenerator: chat with structured cards inline.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  useApiToolDiscoveryStream,
  type DiscoveryMessage,
  type DiscoveryChatItem,
  type ProposedTool,
} from '../hooks/useApiToolDiscoveryStream.js';
import ToolProposalCard from './ToolProposalCard.js';
import type { Agent } from '../types/index.js';

interface Props {
  agent: Agent;
  onClose: () => void;
  /** Called whenever a tool is created/enabled/deleted so parent can refresh */
  onToolsChanged?: () => void;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--bg)',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.75rem 1rem',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  } as React.CSSProperties,
  title: {
    fontSize: '0.95rem',
    fontWeight: 700,
  } as React.CSSProperties,
  closeBtn: {
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: 5,
    color: 'var(--muted)',
    padding: '0.25rem 0.6rem',
    fontSize: '0.78rem',
    cursor: 'pointer',
  } as React.CSSProperties,
  chatArea: {
    flex: 1,
    overflowY: 'auto',
    padding: '1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.6rem',
  } as React.CSSProperties,
  inputArea: {
    display: 'flex',
    gap: '0.5rem',
    padding: '0.75rem 1rem',
    borderTop: '1px solid var(--border)',
    flexShrink: 0,
  } as React.CSSProperties,
  textarea: {
    flex: 1,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--text)',
    padding: '0.5rem 0.75rem',
    fontSize: '0.85rem',
    resize: 'none',
    fontFamily: 'inherit',
    minHeight: 38,
    maxHeight: 120,
  } as React.CSSProperties,
  sendBtn: (active: boolean): React.CSSProperties => ({
    padding: '0.4rem 1rem',
    borderRadius: 6,
    fontSize: '0.85rem',
    fontWeight: 600,
    cursor: active ? 'pointer' : 'not-allowed',
    background: active ? 'var(--accent)' : 'var(--surface)',
    color: active ? '#fff' : 'var(--muted)',
    border: 'none',
    alignSelf: 'flex-end',
  }),
  // Chat bubbles
  userBubble: {
    alignSelf: 'flex-end',
    background: 'var(--accent)',
    color: '#fff',
    padding: '0.5rem 0.85rem',
    borderRadius: '12px 12px 4px 12px',
    maxWidth: '80%',
    fontSize: '0.85rem',
    lineHeight: 1.5,
  } as React.CSSProperties,
  assistantBubble: {
    alignSelf: 'flex-start',
    background: 'var(--surface)',
    color: 'var(--text)',
    padding: '0.5rem 0.85rem',
    borderRadius: '12px 12px 12px 4px',
    maxWidth: '85%',
    fontSize: '0.85rem',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
  } as React.CSSProperties,
  thinkingBubble: {
    alignSelf: 'flex-start',
    color: 'var(--muted)',
    fontSize: '0.8rem',
    fontStyle: 'italic',
    padding: '0.3rem 0',
  } as React.CSSProperties,
  errorBubble: {
    alignSelf: 'flex-start',
    background: '#2a0f0f',
    color: '#e74c3c',
    padding: '0.5rem 0.85rem',
    borderRadius: 8,
    fontSize: '0.82rem',
    border: '1px solid #e74c3c',
  } as React.CSSProperties,
  toolBuilt: {
    alignSelf: 'flex-start',
    background: '#0f2a1a',
    border: '1px solid #2ecc71',
    borderRadius: 8,
    padding: '0.6rem 0.85rem',
    fontSize: '0.82rem',
    color: '#2ecc71',
  } as React.CSSProperties,
  testResult: (ok: boolean): React.CSSProperties => ({
    alignSelf: 'flex-start',
    background: ok ? '#0f2a1a' : '#2a0f0f',
    border: `1px solid ${ok ? '#2ecc71' : '#e74c3c'}`,
    borderRadius: 8,
    padding: '0.6rem 0.85rem',
    fontSize: '0.78rem',
    fontFamily: 'monospace',
    color: ok ? '#2ecc71' : '#e74c3c',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxWidth: '90%',
  }),
  rateLimitWait: {
    alignSelf: 'flex-start',
    background: '#2a2a0f',
    border: '1px solid #f1c40f',
    borderRadius: 8,
    padding: '0.5rem 0.85rem',
    fontSize: '0.82rem',
    color: '#f1c40f',
  } as React.CSSProperties,
  secretStored: {
    alignSelf: 'flex-start',
    background: '#0f1a2a',
    border: '1px solid #3498db',
    borderRadius: 8,
    padding: '0.4rem 0.75rem',
    fontSize: '0.78rem',
    color: '#3498db',
  } as React.CSSProperties,
  enabledBadge: {
    alignSelf: 'flex-start',
    color: '#2ecc71',
    fontSize: '0.82rem',
    fontWeight: 600,
    padding: '0.3rem 0',
  } as React.CSSProperties,
  deletedBadge: {
    alignSelf: 'flex-start',
    color: 'var(--muted)',
    fontSize: '0.82rem',
    fontStyle: 'italic',
    padding: '0.3rem 0',
  } as React.CSSProperties,
  proposalsContainer: {
    alignSelf: 'stretch',
  } as React.CSSProperties,
  loadingDots: {
    alignSelf: 'flex-start',
    color: 'var(--muted)',
    fontSize: '0.85rem',
  } as React.CSSProperties,
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function ApiToolDiscovery({ agent, onClose, onToolsChanged }: Props) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const {
    loading,
    chatItems,
    conversationHistory,
    proposals,
    tokenUsage,
    setProposals,
    appendItem,
    sendMessages,
    setConversationHistory,
    cancel,
  } = useApiToolDiscoveryStream({
    agentId: agent.id,
    autoSend: false,
  });

  // Scroll to bottom on new items
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatItems, loading]);

  // ── Send user message ───────────────────────────────────────────────────

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: DiscoveryMessage = { role: 'user', content: text };
    const updated = [...conversationHistory, userMsg];
    setConversationHistory(updated);
    appendItem({ kind: 'user', text });
    setInput('');
    await sendMessages(updated);
  }, [input, loading, conversationHistory, setConversationHistory, appendItem, sendMessages]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  // ── Proposal approve/deny ───────────────────────────────────────────────

  const handleApprove = useCallback((index: number) => {
    setProposals((prev) => prev.map((p, i) => i === index ? { ...p, status: 'approved' as const } : p));
    // Also update the proposals item in chatItems
    setChatItemProposalStatus(index, 'approved');
  }, [setProposals]);

  const handleDeny = useCallback((index: number) => {
    setProposals((prev) => prev.map((p, i) => i === index ? { ...p, status: 'denied' as const } : p));
    setChatItemProposalStatus(index, 'denied');
  }, [setProposals]);

  // Helper to update proposal status within a chat item
  const setChatItemProposalStatus = (toolIndex: number, status: ProposedTool['status']) => {
    // We don't mutate chatItems directly — the next send will include the decisions
  };

  // ── Submit decisions to agent ───────────────────────────────────────────

  const handleSubmitDecisions = useCallback(async () => {
    const decisions = proposals
      .map((p) => `${p.status === 'approved' ? '✓' : '✕'} ${p.name}: ${p.status}`)
      .join('\n');

    const approved = proposals.filter((p) => p.status === 'approved');
    const denied = proposals.filter((p) => p.status === 'denied');
    const pending = proposals.filter((p) => p.status === 'pending');

    if (pending.length > 0) return; // Not all decided yet

    const summary = [
      `Here are my decisions:`,
      '',
      ...approved.map((p) => `✓ APPROVED: ${p.name}`),
      ...denied.map((p) => `✕ DENIED: ${p.name}`),
      '',
      approved.length > 0
        ? `Please build the ${approved.length} approved tool${approved.length > 1 ? 's' : ''} one at a time.`
        : 'I denied all proposals. Let me know if you have other suggestions.',
    ].join('\n');

    const userMsg: DiscoveryMessage = { role: 'user', content: summary };
    const updated = [...conversationHistory, userMsg];
    setConversationHistory(updated);
    appendItem({ kind: 'user', text: summary });
    await sendMessages(updated);
  }, [proposals, conversationHistory, setConversationHistory, appendItem, sendMessages]);

  // Check if all proposals have been decided
  const allDecided = proposals.length > 0 && proposals.every((p) => p.status !== 'pending');
  const hasApproved = proposals.some((p) => p.status === 'approved');

  // Notify parent when tools change
  const prevBuiltCount = useRef(0);
  useEffect(() => {
    // chatItems changes may include tool_enabled or tool_deleted
    const enabledCount = chatItems.filter((i) => i.kind === 'tool_enabled').length;
    const deletedCount = chatItems.filter((i) => i.kind === 'tool_deleted').length;
    const total = enabledCount + deletedCount;
    if (total > prevBuiltCount.current) {
      prevBuiltCount.current = total;
      onToolsChanged?.();
    }
  }, [chatItems, onToolsChanged]);

  // ── Render chat item ────────────────────────────────────────────────────

  const renderItem = (item: DiscoveryChatItem, idx: number) => {
    switch (item.kind) {
      case 'user':
        return <div key={idx} style={s.userBubble}>{item.text}</div>;
      case 'thinking':
        return <div key={idx} style={s.thinkingBubble}>💭 {item.text}</div>;
      case 'reply':
        return <div key={idx} style={s.assistantBubble}>{item.text}</div>;
      case 'error':
        return <div key={idx} style={s.errorBubble}>⚠ {item.text}</div>;
      case 'fatal_error':
        return <div key={idx} style={s.errorBubble}>🚫 {item.text}</div>;
      case 'proposals':
        return (
          <div key={idx} style={s.proposalsContainer}>
            {proposals.map((tool, i) => (
              <ToolProposalCard
                key={tool.name}
                tool={tool}
                index={i}
                onApprove={handleApprove}
                onDeny={handleDeny}
                disabled={loading}
              />
            ))}
            {allDecided && (
              <button
                style={{
                  ...s.sendBtn(hasApproved),
                  marginTop: '0.5rem',
                  width: '100%',
                }}
                onClick={handleSubmitDecisions}
                disabled={loading || !hasApproved}
              >
                {hasApproved
                  ? `Build ${proposals.filter((p) => p.status === 'approved').length} approved tool${proposals.filter((p) => p.status === 'approved').length > 1 ? 's' : ''}`
                  : 'No tools approved'}
              </button>
            )}
          </div>
        );
      case 'tool_built':
        return (
          <div key={idx} style={s.toolBuilt}>
            🔧 Built: <strong>{item.name}</strong> — {item.description}
          </div>
        );
      case 'tool_test_result': {
        const preview = item.ok
          ? JSON.stringify(item.result, null, 2)?.slice(0, 500)
          : item.error;
        return (
          <div key={idx} style={s.testResult(item.ok)}>
            {item.ok ? '✅' : '❌'} Test {item.ok ? 'passed' : 'failed'} ({item.durationMs}ms)
            {preview && <div style={{ marginTop: '0.4rem', opacity: 0.85 }}>{preview}</div>}
          </div>
        );
      }
      case 'rate_limit_wait':
        return (
          <div key={idx} style={s.rateLimitWait}>
            ⏳ Waiting {item.seconds}s — {item.reason}
          </div>
        );
      case 'secret_stored':
        return (
          <div key={idx} style={s.secretStored}>
            🔐 Secret stored: <strong>{item.key}</strong>
          </div>
        );
      case 'tool_enabled':
        return <div key={idx} style={s.enabledBadge}>✅ Tool enabled and ready to use</div>;
      case 'tool_deleted':
        return <div key={idx} style={s.deletedBadge}>🗑 Tool removed</div>;
      default:
        return null;
    }
  };

  return (
    <div style={s.container}>
      <div style={s.header}>
        <span style={s.title}>✦ Discover & Build API Tools</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {tokenUsage && (
            <span style={{ fontSize: '0.72rem', color: 'var(--muted)', fontFamily: 'monospace' }}>
              {tokenUsage.inputTokens + tokenUsage.outputTokens} tokens · ${tokenUsage.estimatedCostUsd.toFixed(4)}
            </span>
          )}
          <button style={s.closeBtn} onClick={() => { cancel(); onClose(); }}>
            ← Back to tools
          </button>
        </div>
      </div>

      <div style={s.chatArea}>
        {chatItems.length === 0 && !loading && (
          <div style={{ ...s.assistantBubble, opacity: 0.7 }}>
            Tell me which API you'd like to work with. You can paste an API key, name the API, or both.
            <br /><br />
            For example: <em>"I have a NewsAPI key: abc123..."</em> or <em>"Help me build tools for the OpenWeatherMap API"</em>
          </div>
        )}
        {chatItems.map(renderItem)}
        {loading && <div style={s.loadingDots}>●●● thinking...</div>}
        <div ref={bottomRef} />
      </div>

      <div style={s.inputArea}>
        <textarea
          style={s.textarea}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe the API, paste a key, or give feedback..."
          rows={1}
        />
        <button style={s.sendBtn(!!input.trim() && !loading)} onClick={send} disabled={!input.trim() || loading}>
          Send
        </button>
      </div>
    </div>
  );
}
