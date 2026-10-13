import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';
import type { Agent } from '../../types/index.js';
import TabLayout from '../../components/TabLayout.js';

interface Props {
  agent: Agent;
}

export default function ExtensionTab({ agent: _ }: Props) {
  const [connected, setConnected] = useState(false);

  const check = useCallback(async () => {
    try {
      const { connected } = await api.getExtensionStatus();
      setConnected(connected);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    void check();
    const interval = setInterval(check, 3000);
    return () => clearInterval(interval);
  }, [check]);

  return (
    <TabLayout
      title="Browser Extension"
      description="Connect the Chrome extension to enable browser automation tools for your agent."
    >
      {/* Connection status */}
      <div style={{
        background: 'var(--surface)',
        border: `1px solid ${connected ? '#3fb950' : 'var(--border)'}`,
        borderRadius: 8,
        padding: '1.25rem 1.5rem',
        marginBottom: '1.25rem',
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
      }}>
        <div style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: connected ? '#3fb950' : '#6b7280',
          boxShadow: connected ? '0 0 6px #3fb950' : 'none',
          flexShrink: 0,
        }} />
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.2rem' }}>
            {connected ? 'Extension Connected' : 'Extension Not Connected'}
          </div>
          <div style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>
            {connected
              ? 'The Chrome extension is active and ready for browser automation.'
              : 'Load the extension in Chrome to unlock browser automation tools.'}
          </div>
        </div>
      </div>

      {/* Setup instructions */}
      <div style={card}>
        <h4 style={sectionTitle}>Setup Instructions</h4>
        <ol style={{ paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.6rem', fontSize: '0.875rem', color: 'var(--muted)', lineHeight: 1.6, margin: 0 }}>
          <li>Build the extension: <code style={codeStyle}>pnpm --filter=extension build</code></li>
          <li>Open Chrome and navigate to <code style={codeStyle}>chrome://extensions</code></li>
          <li>Enable <strong style={{ color: 'var(--text)' }}>Developer Mode</strong> (top-right toggle)</li>
          <li>Click <strong style={{ color: 'var(--text)' }}>Load unpacked</strong></li>
          <li>Select the <code style={codeStyle}>packages/extension/dist</code> folder</li>
          <li>The extension will automatically connect to the backend</li>
        </ol>
      </div>

      {/* Available primitives */}
      <div style={{ ...card, marginTop: '1rem' }}>
        <h4 style={sectionTitle}>Available Browser Primitives</h4>
        <p style={{ fontSize: '0.82rem', color: 'var(--muted)', marginBottom: '0.75rem' }}>
          These tools become available to your agent when the extension is connected.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
          {['open_tab', 'close_tab', 'navigate', 'wait_for', 'click', 'type_text', 'scroll', 'get_dom', 'get_dom_filtered', 'screenshot', 'execute_code'].map((p) => (
            <code key={p} style={{ ...codeStyle, padding: '0.2rem 0.5rem' }}>{p}</code>
          ))}
        </div>
      </div>
    </TabLayout>
  );
}

const card: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '1.25rem',
};

const sectionTitle: React.CSSProperties = {
  fontSize: '0.875rem',
  fontWeight: 600,
  marginBottom: '0.75rem',
  margin: '0 0 0.75rem',
};

const codeStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '0.1rem 0.4rem',
  fontSize: '0.8rem',
  fontFamily: 'monospace',
  color: 'var(--accent)',
};
