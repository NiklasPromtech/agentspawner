import { useState, useRef, useEffect } from 'react';
import type { FlowDraft } from '../../hooks/useFlowEditorState.js';
import MarkdownContent from '../MarkdownContent.js';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  agentId: string;
  draft: FlowDraft;
  /** When set, pre-fills the textarea and focuses it so the user can review & send. */
  prefillMessage?: string | null;
  onPrefillConsumed?: () => void;
}

export function FlowMasterPanel({ agentId, draft, prefillMessage, onPrefillConsumed }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // When a prefill arrives (e.g. from "Fix with FlowMaster"), populate the textarea
  // but don't auto-send — let the user review and hit ↑
  useEffect(() => {
    if (prefillMessage) {
      setInput(prefillMessage);
      onPrefillConsumed?.();
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [prefillMessage]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');

    const userMsg: Message = { role: 'user', content: text };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setLoading(true);

    try {
      // Send only the last 10 exchanges to keep context window small
      const history = nextMessages.slice(0, -1).slice(-10);

      const res = await fetch(`http://localhost:3001/agents/${agentId}/flow-master/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history,
          flowContext: {
            name: draft.name,
            description: draft.description,
            flowType: draft.flowType ?? null,
            steps: draft.steps.map((s) => ({ label: s.label, toolId: s.toolId })),
          },
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
        throw new Error(err.error ?? res.statusText);
      }

      const data = await res.json() as { reply: string };
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `⚠ ${err instanceof Error ? err.message : 'Request failed'}` },
      ]);
    } finally {
      setLoading(false);
      textareaRef.current?.focus();
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div style={{
      flex: '0 0 40%',
      minWidth: 280,
      display: 'flex',
      flexDirection: 'column',
      borderLeft: '1px solid var(--border)',
      height: '100%',
      background: 'var(--bg)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '0.75rem 1rem',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: '0.95rem' }}>✦</span>
        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>Flow Master</span>
        {messages.length > 0 && (
          <button
            onClick={() => setMessages([])}
            title="Clear conversation"
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              fontSize: '0.75rem',
              padding: '0.1rem 0.3rem',
              borderRadius: 4,
            }}
          >
            clear
          </button>
        )}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {messages.length === 0 && !loading && (
          <div style={{ color: 'var(--muted)', fontSize: '0.8rem', lineHeight: 1.5, padding: '0.5rem 0' }}>
            <p style={{ margin: '0 0 0.5rem' }}>Ask anything about this flow:</p>
            <p style={{ margin: '0 0 0.25rem', color: 'var(--muted)', opacity: 0.7 }}>· Write a transformer for this HTML</p>
            <p style={{ margin: '0 0 0.25rem', color: 'var(--muted)', opacity: 0.7 }}>· What CSS selector should I use?</p>
            <p style={{ margin: '0 0 0.25rem', color: 'var(--muted)', opacity: 0.7 }}>· How do I pass step 2's output to step 4?</p>
            <p style={{ margin: '0 0 0.25rem', color: 'var(--muted)', opacity: 0.7 }}>· Why does my evaluate step always stop?</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {msg.role === 'user' ? 'You' : 'Flow Master'}
            </span>
            {msg.role === 'assistant' ? (
              <div style={{ fontSize: '0.82rem', lineHeight: 1.55, color: 'var(--text)' }}>
                <MarkdownContent>{msg.content}</MarkdownContent>
              </div>
            ) : (
              <div style={{
                fontSize: '0.82rem',
                lineHeight: 1.55,
                color: 'var(--text)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '0.4rem 0.6rem',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {msg.content}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--muted)', fontSize: '0.8rem' }}>
            <span style={{ animation: 'fm-pulse 1s ease-in-out infinite' }}>●</span>
            <span>Thinking…</span>
            <style>{`@keyframes fm-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }`}</style>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ padding: '0.6rem', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-end' }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask Flow Master… (⌘↵ to send)"
            rows={2}
            disabled={loading}
            style={{
              flex: 1,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--text)',
              padding: '0.4rem 0.6rem',
              fontSize: '0.8rem',
              resize: 'none',
              lineHeight: 1.4,
              outline: 'none',
              opacity: loading ? 0.6 : 1,
            }}
          />
          <button
            onClick={() => void send()}
            disabled={!input.trim() || loading}
            style={{
              background: 'var(--accent)',
              border: 'none',
              borderRadius: 6,
              color: '#fff',
              cursor: input.trim() && !loading ? 'pointer' : 'default',
              fontSize: '0.75rem',
              fontWeight: 600,
              padding: '0.4rem 0.6rem',
              opacity: !input.trim() || loading ? 0.4 : 1,
              alignSelf: 'stretch',
              lineHeight: 1,
            }}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}
