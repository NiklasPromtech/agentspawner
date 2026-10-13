import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import type { Agent, Run } from '../types/index.js';

interface Props {
  agent: Agent;
  activeRun?: Run | null;
  onDelete: () => void;
  onStop?: (e: React.MouseEvent) => void;
  onGoToChat?: () => void;
}

export default function AgentCard({ agent, activeRun, onDelete, onStop, onGoToChat }: Props) {
  const navigate = useNavigate();
  const isRunning = !!activeRun;

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    try {
      await api.deleteAgent(agent.id);
      onDelete();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div
      onClick={() => navigate(`/agents/${agent.id}/chat`)}
      style={{
        background: 'var(--surface)',
        border: `1px solid ${isRunning ? '#238636' : 'var(--border)'}`,
        borderRadius: 8,
        padding: '1.25rem',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
        position: 'relative',
        overflow: 'hidden',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = isRunning ? '#3fb950' : 'var(--accent)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = isRunning ? '#238636' : 'var(--border)')}
    >
      {/* Animated green bar at top when running */}
      {isRunning && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          height: 3,
          background: 'linear-gradient(90deg, #238636 0%, #3fb950 50%, #238636 100%)',
          backgroundSize: '200% 100%',
          animation: 'shimmer 2s infinite linear',
        }} />
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.25rem' }}>
            {isRunning && (
              <span style={{
                width: 7, height: 7, borderRadius: '50%',
                background: '#3fb950',
                flexShrink: 0,
                display: 'inline-block',
                animation: 'pulse 1.5s infinite',
              }} />
            )}
            <h3 style={{
              fontSize: '1rem', fontWeight: 600,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {agent.name}
            </h3>
          </div>
          <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{agent.model}</p>
        </div>
        <button
          onClick={handleDelete}
          style={{
            background: 'transparent', border: 'none',
            color: 'var(--muted)', fontSize: '1rem',
            padding: '0 0.25rem', lineHeight: 1, cursor: 'pointer',
          }}
          title="Delete agent"
        >
          ×
        </button>
      </div>

      <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {agent.hasApiKey ? (
          <span style={chipStyle('var(--success)')}>✓ API Key</span>
        ) : (
          <span style={chipStyle('var(--warning)')}>⚠ No API Key</span>
        )}
        <span style={chipStyle('var(--border)')}>
          {new Date(agent.createdAt).toLocaleDateString()}
        </span>
        {isRunning && (
          <span style={chipStyle('#238636')}>● Running</span>
        )}
      </div>

      {/* Go to chat + Stop controls — only when running */}
      {isRunning && (
        <div
          style={{ marginTop: '0.875rem', display: 'flex', gap: '0.5rem' }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={(e) => { e.stopPropagation(); onGoToChat ? onGoToChat() : navigate(`/agents/${agent.id}/chat`); }}
            style={{
              flex: 1,
              background: 'rgba(35,134,54,0.12)',
              border: '1px solid #238636',
              color: '#3fb950',
              borderRadius: 5,
              padding: '0.3rem 0.6rem',
              fontSize: '0.8rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            ↗ Go to chat
          </button>
          <button
            onClick={(e) => onStop?.(e)}
            style={{
              background: 'rgba(248,81,73,0.08)',
              border: '1px solid rgba(248,81,73,0.35)',
              color: '#f85149',
              borderRadius: 5,
              padding: '0.3rem 0.6rem',
              fontSize: '0.8rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            ■ Stop
          </button>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

function chipStyle(color: string): React.CSSProperties {
  return {
    fontSize: '0.75rem',
    padding: '0.15rem 0.5rem',
    borderRadius: 4,
    background: `${color}22`,
    border: `1px solid ${color}55`,
    color,
  };
}
