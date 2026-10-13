/**
 * ToolProposalCard — inline card rendered in the discovery chat.
 * Shows a proposed tool with approve/deny buttons.
 */

import type { ProposedTool } from '../hooks/useApiToolDiscoveryStream.js';

interface Props {
  tool: ProposedTool;
  index: number;
  onApprove: (index: number) => void;
  onDeny: (index: number) => void;
  disabled?: boolean;
}

const s = {
  card: (status: ProposedTool['status']): React.CSSProperties => ({
    background: status === 'approved' ? '#0f2a1a' : status === 'denied' ? '#2a0f0f' : 'var(--surface)',
    border: `1px solid ${status === 'approved' ? '#2ecc71' : status === 'denied' ? '#e74c3c' : 'var(--border)'}`,
    borderRadius: 8,
    padding: '0.85rem 1rem',
    marginBottom: '0.5rem',
  }),
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.4rem',
  } as React.CSSProperties,
  name: {
    fontSize: '0.9rem',
    fontWeight: 700,
    fontFamily: 'monospace',
    color: 'var(--text)',
  } as React.CSSProperties,
  method: (method: string): React.CSSProperties => ({
    fontSize: '0.7rem',
    fontWeight: 700,
    padding: '0.15rem 0.45rem',
    borderRadius: 3,
    background: method === 'GET' ? '#1a3a2a' : method === 'POST' ? '#1a2a3a' : method === 'DELETE' ? '#3a1a1a' : '#2a2a1a',
    color: method === 'GET' ? '#2ecc71' : method === 'POST' ? '#3498db' : method === 'DELETE' ? '#e74c3c' : '#f1c40f',
  }),
  desc: {
    fontSize: '0.82rem',
    color: 'var(--muted)',
    marginBottom: '0.5rem',
    lineHeight: 1.4,
  } as React.CSSProperties,
  meta: {
    fontSize: '0.75rem',
    color: 'var(--muted)',
    fontFamily: 'monospace',
    opacity: 0.7,
    marginBottom: '0.5rem',
  } as React.CSSProperties,
  example: {
    fontSize: '0.75rem',
    color: 'var(--muted)',
    fontFamily: 'monospace',
    background: '#0d0d0d',
    padding: '0.4rem 0.6rem',
    borderRadius: 4,
    marginBottom: '0.6rem',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  } as React.CSSProperties,
  actions: {
    display: 'flex',
    gap: '0.5rem',
  } as React.CSSProperties,
  btn: (variant: 'approve' | 'deny'): React.CSSProperties => ({
    padding: '0.3rem 0.8rem',
    borderRadius: 5,
    fontSize: '0.78rem',
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    background: variant === 'approve' ? '#27ae60' : '#c0392b',
    color: '#fff',
  }),
  statusBadge: (status: 'approved' | 'denied'): React.CSSProperties => ({
    fontSize: '0.75rem',
    fontWeight: 700,
    color: status === 'approved' ? '#2ecc71' : '#e74c3c',
  }),
};

export default function ToolProposalCard({ tool, index, onApprove, onDeny, disabled }: Props) {
  return (
    <div style={s.card(tool.status)}>
      <div style={s.header}>
        <span style={s.name}>{tool.name}</span>
        <span style={s.method(tool.httpMethod)}>{tool.httpMethod}</span>
      </div>
      <div style={s.desc}>{tool.description}</div>
      <div style={s.meta}>{tool.endpointPath} → {tool.whatItReturns}</div>
      <div style={s.example}>{tool.exampleUsage}</div>
      {tool.status === 'pending' ? (
        <div style={s.actions}>
          <button style={s.btn('approve')} onClick={() => onApprove(index)} disabled={disabled}>
            ✓ Approve
          </button>
          <button style={s.btn('deny')} onClick={() => onDeny(index)} disabled={disabled}>
            ✕ Deny
          </button>
        </div>
      ) : (
        <span style={s.statusBadge(tool.status)}>
          {tool.status === 'approved' ? '✓ Approved' : '✕ Denied'}
        </span>
      )}
    </div>
  );
}
