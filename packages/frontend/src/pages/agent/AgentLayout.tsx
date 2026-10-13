import { useEffect, useState } from 'react';
import { useParams, useNavigate, Routes, Route, NavLink } from 'react-router-dom';
import { api } from '../../api/client.js';
import type { Agent, Run } from '../../types/index.js';
import SetupTab from './SetupTab.js';
import ChatTab from './ChatTab.js';
import ToolManagerTab from './ToolManagerTab.js';
import FlowsTab from './FlowsTab.js';
import ExtensionTab from './ExtensionTab.js';
import ScheduleTab from './ScheduleTab.js';
import DatabaseTab from './DatabaseTab.js';
import LoggerTab from './LoggerTab.js';
import MemoryTab from './MemoryTab.js';
import GoalsTab from './GoalsTab.js';
import AnalyticsTab from './AnalyticsTab.js';
import ApiToolsTab from './ApiToolsTab.js';
import ReviewsTab from './ReviewsTab.js';
import ReviewActionsTab from './ReviewActionsTab.js';
import ReviewScrapesTab from './ReviewScrapesTab.js';
import RunTraceTab from './RunTraceTab.js';
import AgentMapTab from './AgentMapTab.js';
import DashboardTab from './DashboardTab.js';

const TABS = [
  { path: 'dashboard', label: 'Dashboard' },
  { path: 'chat',      label: 'Chat' },
  { path: 'goals',     label: 'Goals' },
  { path: 'analytics', label: 'Analytics' },
  { path: 'setup',     label: 'Setup' },
  // 'tools' tab intentionally hidden — tools are auto-provisioned; route still accessible via URL
  { path: 'flows',          label: 'Flows' },
  { path: 'review-actions', label: 'Review Actions', badge: true },
  { path: 'review-scrapes', label: 'Review Scrapes' },
  { path: 'reviews',        label: 'Reviews (Legacy)' },
  { path: 'api-tools', label: 'API Tools' },
  { path: 'extension', label: 'Extension' },
  { path: 'schedule',  label: 'Schedule' },
  { path: 'database',  label: 'Database' },
  { path: 'logs',      label: 'Logs' },
  { path: 'memory',    label: 'Memory' },
  { path: 'trace',     label: 'Trace' },
  { path: 'map',       label: 'Brain Map' },
];

export default function AgentLayout() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [extensionConnected, setExtensionConnected] = useState<boolean | null>(null);
  const [pendingReviewCount, setPendingReviewCount] = useState<number>(0);

  useEffect(() => {
    if (!agentId) return;
    api.getAgent(agentId).then(setAgent).catch(() => navigate('/'));
  }, [agentId, navigate]);

  // Poll for active autonomous run — so the status bar persists across all tabs
  useEffect(() => {
    if (!agentId) return;
    const poll = () => {
      api.getAutonomousStatus(agentId).then((status) => {
        if (status.latestRun?.status === 'running') {
          setActiveRun(status.latestRun);
          setActiveTask(status.currentTask);
        } else {
          setActiveRun(null);
          setActiveTask(null);
        }
      }).catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
  }, [agentId]);

  // Poll extension connection status (OPERATION CONVERGENCE Task 6)
  useEffect(() => {
    const poll = () => {
      api.getExtensionStatus()
        .then((s) => setExtensionConnected(s.connected))
        .catch(() => setExtensionConnected(null));
    };
    poll();
    const interval = setInterval(poll, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Poll pending review count for Review Actions badge (SESSION 6 — OPERATION CLARITY)
  useEffect(() => {
    if (!agentId) return;
    const poll = () => {
      fetch(`http://localhost:3001/agents/${agentId}/action-log?status=pending_review&limit=200`)
        .then((r) => r.json() as Promise<{ status?: string }[]>)
        .then((rows) => setPendingReviewCount(Array.isArray(rows) ? rows.length : 0))
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 15_000);
    return () => clearInterval(interval);
  }, [agentId]);

  const handleStopFromBar = async () => {
    if (!activeRun) return;
    const runId = activeRun.id;
    setActiveRun(null); // optimistic hide
    setActiveTask(null);
    await api.stopRun(runId).catch(console.error);
  };

  if (!agent) return <div style={{ padding: '2rem', color: 'var(--muted)' }}>Loading...</div>;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        padding: '0.75rem 1.5rem',
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
      }}>
        <button
          onClick={() => navigate('/')}
          style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '1.1rem', cursor: 'pointer' }}
        >
          ←
        </button>
        <h2 style={{ fontSize: '1rem', fontWeight: 600 }}>{agent.name}</h2>
        <span style={{ fontSize: '0.8rem', color: 'var(--muted)', background: 'var(--bg)', padding: '0.15rem 0.5rem', borderRadius: 4 }}>
          {agent.model}
        </span>
        {/* Extension connection indicator (OPERATION CONVERGENCE Task 6) */}
        {extensionConnected !== null && (
          <span
            title={extensionConnected ? 'Extension connected' : 'Extension disconnected'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.3rem',
              fontSize: '0.75rem',
              color: extensionConnected ? '#3fb950' : '#da3633',
              background: 'var(--bg)',
              padding: '0.15rem 0.5rem',
              borderRadius: 4,
            }}
          >
            <span style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: extensionConnected ? '#3fb950' : '#da3633',
              boxShadow: extensionConnected ? '0 0 4px #3fb950' : 'none',
              display: 'inline-block',
            }} />
            {extensionConnected ? 'Ext' : 'Ext offline'}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div style={{
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        padding: '0 1.5rem',
        gap: '0.25rem',
      }}>
        {TABS.map((tab) => {
          const badgeCount = tab.badge ? pendingReviewCount : 0;
          return (
            <NavLink
              key={tab.path}
              to={`/agents/${agentId}/${tab.path}`}
              style={({ isActive }) => ({
                padding: '0.6rem 1rem',
                fontSize: '0.875rem',
                color: isActive ? 'var(--accent)' : 'var(--muted)',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                textDecoration: 'none',
                whiteSpace: 'nowrap',
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
              })}
            >
              {tab.label}
              {badgeCount > 0 && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 17,
                  height: 17,
                  borderRadius: 9,
                  background: '#d29922',
                  color: '#000',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  padding: '0 4px',
                  lineHeight: 1,
                }}>
                  {badgeCount}
                </span>
              )}
            </NavLink>
          );
        })}
      </div>

      {/* Active run bar — visible on all tabs when an autonomous run is in progress */}
      {activeRun && (
        <div style={{
          background: 'linear-gradient(90deg, rgba(35,134,54,0.18) 0%, rgba(35,134,54,0.07) 100%)',
          borderBottom: '1px solid #238636',
          borderLeft: '3px solid #3fb950',
          padding: '0.45rem 1rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', minWidth: 0 }}>
            <span style={{ color: '#3fb950', fontSize: '0.6rem', animation: 'pulse 1.2s ease-in-out infinite' }}>●</span>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#3fb950', textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>
              Agent running
            </span>
            {activeTask && (
              <span style={{ fontSize: '0.8rem', color: 'var(--text)', opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                — {activeTask}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
            <NavLink
              to={`/agents/${agentId}/chat`}
              style={{ fontSize: '0.78rem', color: '#3fb950', textDecoration: 'none', padding: '0.2rem 0.6rem', border: '1px solid #238636', borderRadius: 4 }}
            >
              ↗ Go to chat
            </NavLink>
            <button
              onClick={() => void handleStopFromBar()}
              style={{ fontSize: '0.78rem', background: 'rgba(218,54,51,0.15)', color: '#da3633', border: '1px solid #da3633', borderRadius: 4, padding: '0.2rem 0.6rem', cursor: 'pointer' }}
            >
              ■ Stop
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <Routes>
          <Route path="dashboard" element={<DashboardTab agent={agent} />} />
          <Route path="chat" element={<ChatTab agent={agent} />} />
          <Route path="goals"     element={<GoalsTab agent={agent} />} />
          <Route path="analytics" element={<AnalyticsTab agent={agent} />} />
          <Route path="setup"     element={<SetupTab agent={agent} onUpdate={setAgent} />} />
          <Route path="tools" element={<ToolManagerTab agent={agent} />} />
          <Route path="flows" element={<FlowsTab agent={agent} />} />
          <Route path="review-actions" element={<ReviewActionsTab agent={agent} />} />
          <Route path="review-scrapes" element={<ReviewScrapesTab agent={agent} />} />
          <Route path="reviews" element={<ReviewsTab agent={agent} />} />
          <Route path="api-tools" element={<ApiToolsTab agent={agent} />} />
          <Route path="extension" element={<ExtensionTab agent={agent} />} />
          <Route path="schedule" element={<ScheduleTab agent={agent} />} />
          <Route path="database" element={<DatabaseTab agent={agent} />} />
          <Route path="logs" element={<LoggerTab agent={agent} />} />
          <Route path="memory" element={<MemoryTab agent={agent} />} />
          <Route path="trace"  element={<RunTraceTab agent={agent} />} />
          <Route path="map"    element={<AgentMapTab agent={agent} />} />
          <Route path="" element={<ChatTab agent={agent} />} />
        </Routes>
      </div>
    </div>
  );
}
