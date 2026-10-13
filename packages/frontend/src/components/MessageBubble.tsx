import { useState } from 'react';
import type { SseEvent } from '../types/index.js';
import MarkdownContent from './MarkdownContent.js';

interface Props {
  event: SseEvent;
  flowIdByName?: Record<string, string>;
}

const SOURCE_LABEL: Record<string, { label: string; color: string }> = {
  manager: { label: '◆ Manager', color: '#58a6ff' },
  chat:    { label: '◇ Chat',    color: '#8b949e' },
};

export default function MessageBubble({ event, flowIdByName }: Props) {
  const [copied, setCopied] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(false);

  const handleCopyFlowId = (flowId: string) => {
    void navigator.clipboard.writeText(flowId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // ── Wake-up context panel ────────────────────────────────────────────────
  if (event.type === 'wake_up_context') {
    const text = typeof event.content === 'string' ? event.content : '';
    // Pull out the timestamp from "Continuous autonomous run started at <ISO>"
    const tsMatch = text.match(/Continuous autonomous run started at ([^\s.]+)/);
    const ts = tsMatch ? new Date(tsMatch[1]).toLocaleTimeString() : '';
    return (
      <div style={{
        alignSelf: 'flex-start',
        maxWidth: '90%',
        borderRadius: 8,
        border: '1px solid #30363d',
        background: '#0d1117',
        fontSize: '0.8rem',
        overflow: 'hidden',
      }}>
        <button
          onClick={() => setContextExpanded((v) => !v)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.55rem 0.9rem',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: '#58a6ff',
            fontSize: '0.8rem',
            textAlign: 'left',
          }}
        >
          <span>{contextExpanded ? '▾' : '▸'}</span>
          <span style={{ fontWeight: 600 }}>📋 Wake-up context</span>
          {ts && <span style={{ color: '#8b949e', marginLeft: 'auto', fontSize: '0.72rem' }}>{ts}</span>}
        </button>
        {contextExpanded && (
          <pre style={{
            margin: 0,
            padding: '0.75rem 0.9rem',
            borderTop: '1px solid #30363d',
            color: 'var(--muted)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 500,
            overflowY: 'auto',
            fontSize: '0.75rem',
            lineHeight: 1.5,
          }}>
            {text}
          </pre>
        )}
      </div>
    );
  }

  // ── Regular message ──────────────────────────────────────────────────────
  if (event.type === 'message') {
    const content = event.content;
    const text = Array.isArray(content)
      ? content
          .filter((b: { type: string; text?: string }) => b.type === 'text')
          .map((b: { text: string }) => b.text)
          .join('')
      : String(content ?? '');

    if (!text) return null;

    const isUser = event.role === 'user';
    const sourceInfo = !isUser && event.source ? SOURCE_LABEL[event.source] : null;

    return (
      <div style={{
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '85%',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.2rem',
      }}>
        {sourceInfo && (
          <span style={{
            fontSize: '0.68rem',
            color: sourceInfo.color,
            fontWeight: 600,
            letterSpacing: '0.03em',
            paddingLeft: '0.25rem',
          }}>
            {sourceInfo.label}
          </span>
        )}
        <div style={{
          padding: '0.75rem 1rem',
          borderRadius: 8,
          background: isUser ? '#1f3a5f' : 'var(--surface)',
          border: '1px solid var(--border)',
          wordBreak: 'break-word',
          fontSize: '0.9rem',
          lineHeight: 1.6,
          // user messages keep pre-wrap; assistant messages are rendered as markdown
          whiteSpace: isUser ? 'pre-wrap' : undefined,
        }}>
          {isUser ? text : <MarkdownContent>{text}</MarkdownContent>}
        </div>
      </div>
    );
  }

  // ── Tool call ────────────────────────────────────────────────────────────
  if (event.type === 'tool_call') {
    const flowId = flowIdByName && event.toolName ? flowIdByName[event.toolName] : undefined;
    const sourceInfo = event.source ? SOURCE_LABEL[event.source] : null;
    return (
      <div style={{
        padding: '0.6rem 0.9rem',
        borderRadius: 6,
        background: '#0d1117',
        border: '1px solid #30363d',
        fontSize: '0.8rem',
        fontFamily: 'monospace',
        alignSelf: 'flex-start',
        maxWidth: '85%',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
          {sourceInfo && (
            <span style={{ color: sourceInfo.color, fontSize: '0.68rem', fontFamily: 'sans-serif', fontWeight: 600 }}>
              {sourceInfo.label}
            </span>
          )}
          <span style={{ color: '#d29922' }}>⚡ {event.toolName}</span>
          {flowId && (
            <button
              onClick={() => handleCopyFlowId(flowId)}
              title={`Copy flow ID: ${flowId}`}
              style={{
                background: 'none',
                border: '1px solid #30363d',
                borderRadius: 4,
                color: copied ? '#3fb950' : '#8b949e',
                cursor: 'pointer',
                fontSize: '0.7rem',
                padding: '0.1rem 0.4rem',
                fontFamily: 'monospace',
                lineHeight: 1.4,
              }}
            >
              {copied ? '✓ copied' : 'copy ID'}
            </button>
          )}
        </div>
        <pre style={{ color: 'var(--muted)', overflow: 'auto', margin: 0 }}>
          {JSON.stringify(event.input, null, 2)}
        </pre>
      </div>
    );
  }

  // ── Tool result ──────────────────────────────────────────────────────────
  if (event.type === 'tool_result') {
    return (
      <div style={{
        padding: '0.6rem 0.9rem',
        borderRadius: 6,
        background: '#0d1117',
        border: `1px solid ${event.error ? '#f8514933' : '#3fb95033'}`,
        fontSize: '0.8rem',
        fontFamily: 'monospace',
        alignSelf: 'flex-start',
        maxWidth: '85%',
      }}>
        <div style={{ color: event.error ? 'var(--error)' : 'var(--success)', marginBottom: '0.25rem' }}>
          {event.error ? '✗ Error' : '✓ Result'}
        </div>
        <pre style={{ color: 'var(--muted)', overflow: 'auto', maxHeight: 200, margin: 0 }}>
          {(event.error ?? event.result ?? '').replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[screenshot]')}
        </pre>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (event.type === 'error') {
    return (
      <div style={{
        padding: '0.6rem 0.9rem',
        borderRadius: 6,
        background: '#2d0d0d',
        border: '1px solid var(--error)',
        fontSize: '0.85rem',
        color: 'var(--error)',
        alignSelf: 'flex-start',
      }}>
        ✗ {event.message}
      </div>
    );
  }

  return null;
}
