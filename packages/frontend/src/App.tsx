import { Routes, Route } from 'react-router-dom';
import Home from './pages/Home.js';
import AgentLayout from './pages/agent/AgentLayout.js';
import AgentOnboarding from './pages/AgentOnboarding.js';
import ActionFlowTestPage from './pages/ActionFlowTestPage.js';

const styles = `
  :root {
    --bg: #0f1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #e1e4e8;
    --muted: #8b949e;
    --accent: #58a6ff;
    --success: #3fb950;
    --error: #f85149;
    --warning: #d29922;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; }
  button { cursor: pointer; font-family: inherit; }
  input, textarea, select { font-family: inherit; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
`;

export default function App() {
  return (
    <>
      <style>{styles}</style>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/agents/new" element={<AgentOnboarding />} />
        <Route path="/agents/:agentId/*" element={<AgentLayout />} />
        <Route path="/test/action-flow" element={<ActionFlowTestPage />} />
      </Routes>
    </>
  );
}
