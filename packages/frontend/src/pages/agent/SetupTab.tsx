import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import type { Agent, ProfileBlob } from '../../types/index.js';

interface Props {
  agent: Agent;
  onUpdate: (agent: Agent) => void;
}

const MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

type View = 'view' | 'amend' | 'raw' | 'generate';

interface AmendMessage {
  role: 'user' | 'assistant';
  content: string;
}

export default function SetupTab({ agent, onUpdate }: Props) {
  const navigate = useNavigate();
  const hasExistingBrief = Boolean(agent.systemPrompt?.trim());

  const [view, setView] = useState<View>(hasExistingBrief ? 'view' : 'generate');

  // ── Shared state ────────────────────────────────────────────────────────────
  const [model, setModel] = useState(agent.model);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('anthropic_api_key') ?? '');
  const [telegramKey, setTelegramKey] = useState('');
  const [telegramChatId, setTelegramChatId] = useState(agent.telegramChatId);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // ── View mode: the live prompt to display/save ───────────────────────────────
  const [activePrompt, setActivePrompt] = useState(agent.systemPrompt ?? '');

  // ── Amend mode state ─────────────────────────────────────────────────────────
  const [amendMessages, setAmendMessages] = useState<AmendMessage[]>([]);
  const [amendInput, setAmendInput] = useState('');
  const [amendLoading, setAmendLoading] = useState(false);
  const [proposedPrompt, setProposedPrompt] = useState<string | null>(null);
  const amendBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    amendBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [amendMessages, amendLoading]);

  // ── Raw mode state ────────────────────────────────────────────────────────────
  const [rawPrompt, setRawPrompt] = useState(agent.systemPrompt ?? '');

  // ── Generate mode state ───────────────────────────────────────────────────────
  const [roleTitle, setRoleTitle] = useState(agent.name);
  const [companyUrl, setCompanyUrl] = useState('');
  const [companyContext, setCompanyContext] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [fetchingCompany, setFetchingCompany] = useState(false);
  const [companyFetchDone, setCompanyFetchDone] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatedPrompt, setGeneratedPrompt] = useState('');
  const [recommendedFlows, setRecommendedFlows] = useState<{ name: string; description: string }[]>([]);
  const [recommendedDatabases, setRecommendedDatabases] = useState<{ name: string; description: string; columns: { name: string; type: string }[] }[]>([]);
  const [recommendedSchedules, setRecommendedSchedules] = useState<{ flowName: string; cron: string; label: string; input: string }[]>([]);
  const [generationFeedback, setGenerationFeedback] = useState('');
  const [hasGenerated, setHasGenerated] = useState(false);

  // ── Handlers ──────────────────────────────────────────────────────────────────

  const handleSave = async (promptOverride?: string) => {
    setSaving(true);
    try {
      if (apiKey.trim()) localStorage.setItem('anthropic_api_key', apiKey.trim());
      const systemPrompt = promptOverride ?? activePrompt;
      const updated = await api.updateAgent(agent.id, {
        name: agent.name,
        model,
        systemPrompt,
        apiKey,
        telegramKey,
        telegramChatId,
      });
      onUpdate(updated);
      setActivePrompt(systemPrompt);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // ── Amend handlers ────────────────────────────────────────────────────────────

  const handleAmendSend = async () => {
    const text = amendInput.trim();
    if (!text || amendLoading) return;

    const newMessages: AmendMessage[] = [...amendMessages, { role: 'user', content: text }];
    setAmendMessages(newMessages);
    setAmendInput('');
    setAmendLoading(true);

    try {
      // Use the latest proposed prompt as the "current" base if we've already iterated
      const currentBase = proposedPrompt ?? activePrompt;
      const result = await api.amendSetup(agent.id, {
        currentPrompt: currentBase,
        messages: newMessages,
      });
      setProposedPrompt(result.proposedPrompt);
      setAmendMessages((prev) => [
        ...prev,
        { role: 'assistant', content: result.explanation },
      ]);
    } catch (err) {
      setAmendMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : 'Something went wrong'}` },
      ]);
    } finally {
      setAmendLoading(false);
    }
  };

  const handleAmendApply = async () => {
    if (!proposedPrompt) return;
    await handleSave(proposedPrompt);
    setRawPrompt(proposedPrompt);
    setView('view');
    setAmendMessages([]);
    setProposedPrompt(null);
  };

  const handleAmendCancel = () => {
    setAmendMessages([]);
    setProposedPrompt(null);
    setAmendInput('');
    setView('view');
  };

  // ── Raw save ──────────────────────────────────────────────────────────────────

  const handleRawSave = async () => {
    await handleSave(rawPrompt);
    setView('view');
  };

  // ── Generate handlers ─────────────────────────────────────────────────────────

  const handleFetchCompany = async () => {
    if (!companyUrl.trim()) return;
    setFetchingCompany(true);
    try {
      const result = await api.fetchCompany(agent.id, companyUrl.trim());
      setCompanyContext(result.summary);
      if (result.name) setCompanyName(result.name);
      setCompanyFetchDone(true);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to fetch company info');
    } finally {
      setFetchingCompany(false);
    }
  };

  const runGenerate = async (feedbackSuffix?: string) => {
    setGenerating(true);
    try {
      const jd = feedbackSuffix ? `${jobDescription}\n\nFeedback: ${feedbackSuffix}` : jobDescription;
      const result = await api.generateSetup(agent.id, { roleTitle, companyContext, jobDescription: jd });
      setGeneratedPrompt(result.systemPrompt);
      setRecommendedFlows(result.recommendedFlows);
      setRecommendedDatabases(result.recommendedDatabases ?? []);
      setRecommendedSchedules(result.recommendedSchedules ?? []);
      setHasGenerated(true);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateSave = async () => {
    setSaving(true);
    try {
      if (apiKey.trim()) localStorage.setItem('anthropic_api_key', apiKey.trim());
      const updated = await api.updateAgent(agent.id, {
        name: roleTitle,
        model,
        systemPrompt: generatedPrompt,
        apiKey,
        telegramKey,
        telegramChatId,
      });
      onUpdate(updated);
      setActivePrompt(generatedPrompt);
      setRawPrompt(generatedPrompt);
      setSaved(true);
      setTimeout(() => { setSaved(false); setView('view'); }, 1000);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateWithAI = (description: string) => {
    navigate(`/agents/${agent.id}/flows`, {
      state: { openGenerator: true, prefillMessage: description },
    });
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  // ── AMEND VIEW ────────────────────────────────────────────────────────────────
  if (view === 'amend') {
    return (
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
          <button onClick={handleAmendCancel} style={backBtnStyle}>← Back</button>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>Amend Brief</h3>
        </div>

        {/* Chat area */}
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '1rem',
          minHeight: 160,
          maxHeight: 320,
          overflowY: 'auto',
          marginBottom: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
        }}>
          {amendMessages.length === 0 && (
            <p style={{ color: 'var(--muted)', fontSize: '0.875rem', margin: 0 }}>
              Describe what you'd like to change about the brief…
            </p>
          )}
          {amendMessages.map((m, i) => (
            <div key={i} style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: m.role === 'user' ? 'flex-end' : 'flex-start',
            }}>
              <div style={{
                background: m.role === 'user' ? '#1f6feb33' : 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '0.5rem 0.75rem',
                fontSize: '0.875rem',
                maxWidth: '85%',
                lineHeight: 1.5,
              }}>
                {m.content}
              </div>
            </div>
          ))}
          {amendLoading && (
            <div style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>✦ Thinking…</div>
          )}
          <div ref={amendBottomRef} />
        </div>

        {/* Proposed brief — shown once AI has responded */}
        {proposedPrompt && (
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.82rem', color: 'var(--muted)', marginBottom: '0.4rem', fontWeight: 600 }}>
              Proposed brief
            </label>
            <textarea
              value={proposedPrompt}
              onChange={(e) => setProposedPrompt(e.target.value)}
              rows={8}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: '0.85rem' }}
            />
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button
                onClick={() => void handleAmendApply()}
                disabled={saving}
                style={{ ...saveBtnStyle, background: saved ? '#238636' : '#1f6feb', opacity: saving ? 0.6 : 1 }}
              >
                {saving ? 'Saving…' : '✓ Apply Brief'}
              </button>
              <button onClick={handleAmendCancel} style={cancelBtnStyle}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Input */}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <textarea
            value={amendInput}
            onChange={(e) => setAmendInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleAmendSend(); } }}
            placeholder="Describe the change you want… (Enter to send)"
            rows={2}
            disabled={amendLoading}
            style={{ ...inputStyle, resize: 'none', flex: 1 }}
          />
          <button
            onClick={() => void handleAmendSend()}
            disabled={amendLoading || !amendInput.trim()}
            style={{ ...fetchBtnStyle, alignSelf: 'flex-end', opacity: amendLoading || !amendInput.trim() ? 0.5 : 1 }}
          >
            Send
          </button>
        </div>
      </div>
    );
  }

  // ── RAW VIEW ──────────────────────────────────────────────────────────────────
  if (view === 'raw') {
    return (
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
          <button onClick={() => setView(hasExistingBrief ? 'view' : 'generate')} style={backBtnStyle}>← Back</button>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>Edit Raw Prompt</h3>
        </div>

        <Field label="System Prompt">
          <textarea
            value={rawPrompt}
            onChange={(e) => setRawPrompt(e.target.value)}
            rows={12}
            placeholder="You are a helpful assistant..."
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: '0.875rem' }}
          />
        </Field>

        <SharedFields
          model={model} setModel={setModel}
          apiKey={apiKey} setApiKey={setApiKey}
          hasApiKey={agent.hasApiKey}
          telegramKey={telegramKey} setTelegramKey={setTelegramKey}
          telegramChatId={telegramChatId} setTelegramChatId={setTelegramChatId}
        />

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={() => void handleRawSave()}
            disabled={saving}
            style={{ ...saveBtnStyle, background: saved ? '#238636' : '#1f6feb', opacity: saving ? 0.7 : 1 }}
          >
            {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
          </button>
          <button onClick={() => setView(hasExistingBrief ? 'view' : 'generate')} style={cancelBtnStyle}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── VIEW (structured dashboard) ───────────────────────────────────────────────
  if (view === 'view') {
    return (
      <ProfileDashboard
        agent={agent}
        onUpdate={onUpdate}
        model={model} setModel={setModel}
        apiKey={apiKey} setApiKey={setApiKey}
        telegramKey={telegramKey} setTelegramKey={setTelegramKey}
        telegramChatId={telegramChatId} setTelegramChatId={setTelegramChatId}
        saving={saving} saved={saved}
        onAmend={() => { setAmendMessages([]); setProposedPrompt(null); setView('amend'); }}
        onEditRaw={() => { setRawPrompt(activePrompt); setView('raw'); }}
        onGenerate={() => setView('generate')}
        onSaveModelKeys={() => void handleSave()}
      />
    );
  }

  // ── GENERATE VIEW (no existing brief) ────────────────────────────────────────
  const generateDisabled = !roleTitle.trim() || !jobDescription.trim() || generating;
  const hasRecommendations = hasGenerated && (
    recommendedFlows.length > 0 || recommendedDatabases.length > 0 || recommendedSchedules.length > 0
  );

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>Job Brief</h3>
        <button onClick={() => { setRawPrompt(''); setView('raw'); }} style={toggleBtnStyle}>
          Edit raw prompt
        </button>
      </div>

      <Field label="Role title">
        <input
          value={roleTitle}
          onChange={(e) => setRoleTitle(e.target.value)}
          placeholder="e.g. LinkedIn SDR, Twitter community manager"
          style={inputStyle}
        />
      </Field>

      <Field label="Company website (optional)">
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            value={companyUrl}
            onChange={(e) => { setCompanyUrl(e.target.value); setCompanyFetchDone(false); }}
            placeholder="https://acme.com"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            onClick={() => void handleFetchCompany()}
            disabled={fetchingCompany || !companyUrl.trim()}
            style={fetchBtnStyle}
          >
            {fetchingCompany ? 'Fetching…' : 'Fetch'}
          </button>
        </div>
      </Field>

      {companyFetchDone && companyContext && (
        <CompanyCard name={companyName} summary={companyContext} />
      )}

      <Field label="What does this agent do?">
        <textarea
          value={jobDescription}
          onChange={(e) => setJobDescription(e.target.value)}
          rows={4}
          placeholder="Describe the agent's tasks, target platform, and goals…"
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </Field>

      <SharedFields
        model={model} setModel={setModel}
        apiKey={apiKey} setApiKey={setApiKey}
        hasApiKey={agent.hasApiKey}
        telegramKey={telegramKey} setTelegramKey={setTelegramKey}
        telegramChatId={telegramChatId} setTelegramChatId={setTelegramChatId}
      />

      <button
        onClick={() => void runGenerate()}
        disabled={generateDisabled}
        style={{ ...generateBtnStyle, opacity: generateDisabled ? 0.5 : 1, cursor: generateDisabled ? 'not-allowed' : 'pointer' }}
      >
        {generating ? 'Generating…' : '✦ Generate'}
      </button>

      {hasGenerated && (
        <div style={{ marginTop: '1.5rem' }}>
          <Field label="Generated system prompt">
            <textarea
              value={generatedPrompt}
              onChange={(e) => setGeneratedPrompt(e.target.value)}
              rows={8}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: '0.85rem' }}
            />
          </Field>
          <Field label="Feedback (optional — leave blank to keep as-is)">
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                value={generationFeedback}
                onChange={(e) => setGenerationFeedback(e.target.value)}
                placeholder="e.g. Make it more concise, add focus on LinkedIn Sales Navigator"
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                onClick={() => void runGenerate(generationFeedback.trim() || undefined)}
                disabled={generating}
                style={{ ...fetchBtnStyle, opacity: generating ? 0.6 : 1 }}
              >
                {generating ? '…' : 'Regenerate'}
              </button>
            </div>
          </Field>
        </div>
      )}

      <button
        onClick={() => void handleGenerateSave()}
        disabled={saving || !hasGenerated}
        style={{
          ...saveBtnStyle,
          background: saved ? '#238636' : '#1f6feb',
          opacity: saving || !hasGenerated ? 0.6 : 1,
          cursor: saving || !hasGenerated ? 'not-allowed' : 'pointer',
          marginTop: '0.5rem',
        }}
      >
        {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
      </button>
      {!hasGenerated && (
        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.4rem' }}>
          Generate first, or switch to raw mode.
        </p>
      )}

      {hasRecommendations && (
        <div style={{ marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px dashed var(--border)' }}>
          <div style={{ marginBottom: '1.25rem' }}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 600, margin: '0 0 0.25rem' }}>Recommended setup</h4>
            <p style={{ fontSize: '0.8rem', color: 'var(--muted)', margin: 0 }}>
              Build these out and your agent will be ready to run autonomously.
            </p>
          </div>

          {recommendedFlows.length > 0 && (
            <RecommendationGroup title="Flows" subtitle="Atomic automations — build each one separately.">
              {recommendedFlows.map((flow) => (
                <RecommendedFlowCard key={flow.name} name={flow.name} description={flow.description} onCreateWithAI={handleCreateWithAI} />
              ))}
            </RecommendationGroup>
          )}

          {recommendedDatabases.length > 0 && (
            <RecommendationGroup title="Databases" subtitle="Tables the agent reads and writes during its work.">
              {recommendedDatabases.map((db) => (
                <RecommendedDatabaseCard key={db.name} name={db.name} description={db.description} columns={db.columns} agentId={agent.id} />
              ))}
            </RecommendationGroup>
          )}

          {recommendedSchedules.length > 0 && (
            <RecommendationGroup title="Schedules" subtitle="Cron jobs to run flows automatically. Disabled by default — enable once flows are built.">
              {recommendedSchedules.map((sched) => (
                <RecommendedScheduleCard key={sched.flowName} flowName={sched.flowName} cron={sched.cron} label={sched.label} input={sched.input} agentId={agent.id} />
              ))}
            </RecommendationGroup>
          )}
        </div>
      )}
    </div>
  );
}

// ── ProfileDashboard ──────────────────────────────────────────────────────────

const EMPTY_BLOB: ProfileBlob = {
  jobDescription: '',
  competitors: [],
  tone: [],
  allowed: [],
  restricted: [],
  focus: '',
  mindset: '',
};

interface ProfileDashboardProps {
  agent: Agent;
  onUpdate: (agent: Agent) => void;
  model: string; setModel: (v: string) => void;
  apiKey: string; setApiKey: (v: string) => void;
  telegramKey: string; setTelegramKey: (v: string) => void;
  telegramChatId: string; setTelegramChatId: (v: string) => void;
  saving: boolean; saved: boolean;
  onAmend: () => void;
  onEditRaw: () => void;
  onGenerate: () => void;
  onSaveModelKeys: () => void;
}

function ProfileDashboard({
  agent, onUpdate,
  model, setModel, apiKey, setApiKey, telegramKey, setTelegramKey,
  telegramChatId, setTelegramChatId,
  saving, saved,
  onAmend, onEditRaw, onGenerate, onSaveModelKeys,
}: ProfileDashboardProps) {
  const blob: ProfileBlob | null = agent.profileBlob
    ? (() => { try { return JSON.parse(agent.profileBlob!) as ProfileBlob; } catch { return null; } })()
    : null;

  // Per-section saving state
  const [sectionSaving, setSectionSaving] = useState<Record<string, boolean>>({});
  const [sectionSaved, setSectionSaved] = useState<Record<string, boolean>>({});

  // ── Learned tone guide state (AI-generated override layer) ─────────────────
  interface ToneStatus {
    toneGuide: string[];
    toneGuideUpdatedAt: string | null;
    editCount: number;
    lastError: string | null;
    lastErrorAt: string | null;
  }
  const [toneStatus, setToneStatus] = useState<ToneStatus | null>(null);
  const [toneStatusLoading, setToneStatusLoading] = useState(true);
  const [toneRefreshing, setToneRefreshing] = useState(false);
  const [toneRefreshMsg, setToneRefreshMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let mounted = true;
    api.getToneStatus(agent.id)
      .then((s) => { if (mounted) setToneStatus(s); })
      .catch(() => { /* non-fatal */ })
      .finally(() => { if (mounted) setToneStatusLoading(false); });
    return () => { mounted = false; };
  }, [agent.id]);

  const handleToneRefresh = async () => {
    setToneRefreshing(true);
    setToneRefreshMsg(null);
    try {
      const result = await api.refreshAgentToneGuide(agent.id);
      setToneStatus({
        toneGuide: result.toneGuide,
        toneGuideUpdatedAt: result.toneGuideUpdatedAt,
        editCount: toneStatus?.editCount ?? 0,
        lastError: null,
        lastErrorAt: null,
      });
      setToneRefreshMsg({ ok: true, text: 'Tone guide refreshed successfully.' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Refresh failed';
      setToneRefreshMsg({ ok: false, text: msg });
      // Re-fetch status so error fields are up-to-date
      api.getToneStatus(agent.id).then(setToneStatus).catch(() => {});
    } finally {
      setToneRefreshing(false);
    }
  };

  // ── Local editable state for each section ──────────────────────────────────
  const [jobDescription, setJobDescription] = useState(blob?.jobDescription ?? '');
  const [focus, setFocus] = useState(blob?.focus ?? '');
  const [mindset, setMindset] = useState(blob?.mindset ?? '');
  const [tone, setTone] = useState<string[]>(blob?.tone ?? []);
  const [toneInput, setToneInput] = useState('');
  const [allowed, setAllowed] = useState<string[]>(blob?.allowed ?? []);
  const [allowedInput, setAllowedInput] = useState('');
  const [restricted, setRestricted] = useState<string[]>(blob?.restricted ?? []);
  const [restrictedInput, setRestrictedInput] = useState('');
  const [competitors, setCompetitors] = useState<{ name: string; url?: string; notes: string }[]>(blob?.competitors ?? []);

  const saveSection = async (key: string, partial: Partial<ProfileBlob>) => {
    setSectionSaving((p) => ({ ...p, [key]: true }));
    try {
      const current: ProfileBlob = blob ?? EMPTY_BLOB;
      const next: ProfileBlob = { ...current, ...partial };
      const updated = await api.patchAgent(agent.id, { profileBlob: JSON.stringify(next) });
      onUpdate(updated);
      setSectionSaved((p) => ({ ...p, [key]: true }));
      setTimeout(() => setSectionSaved((p) => ({ ...p, [key]: false })), 2000);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSectionSaving((p) => ({ ...p, [key]: false }));
    }
  };

  // If no profileBlob, show generate prompt
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const hasPrompt = Boolean(agent.systemPrompt?.trim());

  const handleParsePrompt = async () => {
    setParsing(true);
    setParseError(null);
    try {
      await api.parsePrompt(agent.id);
      // Reload the agent so the parent picks up the new profileBlob
      const updated = await api.getAgent(agent.id);
      onUpdate(updated);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Parse failed');
    } finally {
      setParsing(false);
    }
  };

  if (!blob) {
    return (
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>Agent Setup</h3>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={onAmend} style={toggleBtnStyle}>✦ Amend</button>
            <button onClick={onEditRaw} style={toggleBtnStyle}>Edit raw</button>
          </div>
        </div>
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '2rem',
          textAlign: 'center',
          marginBottom: '1.5rem',
        }}>
          {hasPrompt ? (
            <>
              <p style={{ fontSize: '0.9rem', color: 'var(--muted)', marginBottom: '1.25rem', lineHeight: 1.5 }}>
                You have a system prompt but no structured profile yet.<br />
                Parse it to get the full dashboard view.
              </p>
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={() => void handleParsePrompt()}
                  disabled={parsing}
                  style={{
                    background: 'linear-gradient(135deg, #1f6feb, #1158c7)',
                    color: '#fff', border: 'none', borderRadius: 6,
                    padding: '0.6rem 1.5rem', fontSize: '0.9rem', fontWeight: 600, cursor: parsing ? 'not-allowed' : 'pointer',
                    opacity: parsing ? 0.7 : 1,
                  }}
                >
                  {parsing ? '⏳ Parsing prompt…' : '⚡ Parse from system prompt'}
                </button>
                <button onClick={onGenerate} style={{
                  background: 'transparent', border: '1px solid var(--border)',
                  color: 'var(--muted)', borderRadius: 6,
                  padding: '0.6rem 1.25rem', fontSize: '0.875rem', cursor: 'pointer',
                }}>
                  ✦ Regenerate from scratch
                </button>
              </div>
              {parseError && (
                <p style={{ fontSize: '0.8rem', color: '#f85149', marginTop: '0.75rem' }}>⚠ {parseError}</p>
              )}
            </>
          ) : (
            <>
              <p style={{ fontSize: '0.95rem', color: 'var(--muted)', marginBottom: '1rem' }}>
                No system prompt yet. Run <strong>Generate</strong> to build your profile dashboard.
              </p>
              <button onClick={onGenerate} style={{
                background: 'linear-gradient(135deg, #238636, #1a6a2a)',
                color: '#fff', border: 'none', borderRadius: 6,
                padding: '0.6rem 1.5rem', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer',
              }}>
                ✦ Generate Profile
              </button>
            </>
          )}
        </div>
        <SharedFields
          model={model} setModel={setModel}
          apiKey={apiKey} setApiKey={setApiKey}
          hasApiKey={agent.hasApiKey}
          telegramKey={telegramKey} setTelegramKey={setTelegramKey}
          telegramChatId={telegramChatId} setTelegramChatId={setTelegramChatId}
        />
        <button
          onClick={onSaveModelKeys}
          disabled={saving}
          style={{ ...saveBtnStyle, background: saved ? '#238636' : '#1f6feb', opacity: saving ? 0.7 : 1 }}
        >
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
        </button>
      </div>
    );
  }

  const mk = (key: string) => ({
    isSaving: !!sectionSaving[key],
    isSaved: !!sectionSaved[key],
  });

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '1.5rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>Agent Setup</h3>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={onAmend} style={toggleBtnStyle}>✦ Amend</button>
          <button onClick={onEditRaw} style={toggleBtnStyle}>Edit raw</button>
        </div>
      </div>

      {/* Job Description */}
      <DashCard title="Job Description" {...mk('jobDescription')} onSave={() => saveSection('jobDescription', { jobDescription })}>
        <textarea
          value={jobDescription}
          onChange={(e) => setJobDescription(e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </DashCard>

      {/* Focus */}
      <DashCard title="Focus" {...mk('focus')} onSave={() => saveSection('focus', { focus })}>
        <textarea
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          rows={2}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </DashCard>

      {/* Mindset */}
      <DashCard title="Mindset" {...mk('mindset')} onSave={() => saveSection('mindset', { mindset })}>
        <textarea
          value={mindset}
          onChange={(e) => setMindset(e.target.value)}
          rows={2}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </DashCard>

      {/* Tone */}
      <DashCard title="Tone" {...mk('tone')} onSave={() => saveSection('tone', { tone })}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '0.6rem' }}>
          {tone.map((item, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ flex: 1, fontSize: '0.875rem' }}>• {item}</span>
              <button onClick={() => setTone(tone.filter((_, j) => j !== i))} style={removeTagBtnStyle}>×</button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            value={toneInput}
            onChange={(e) => setToneInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && toneInput.trim()) { setTone([...tone, toneInput.trim()]); setToneInput(''); } }}
            placeholder="Add tone guideline…"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            onClick={() => { if (toneInput.trim()) { setTone([...tone, toneInput.trim()]); setToneInput(''); } }}
            disabled={!toneInput.trim()}
            style={fetchBtnStyle}
          >
            + Add
          </button>
        </div>
      </DashCard>

      {/* ── Learned Tone Guide (AI override layer) ─────────────────────────── */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '1rem 1.25rem',
        marginBottom: '1rem',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
          <div>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>
              Learned Tone Guide
            </span>
            <p style={{ margin: '0.2rem 0 0', fontSize: '0.8rem', color: 'var(--muted)' }}>
              Auto-generated from human edits to approved content. Overrides the base tone above.
            </p>
          </div>
          <button
            onClick={() => void handleToneRefresh()}
            disabled={toneRefreshing || (toneStatus?.editCount ?? 0) < 3}
            title={(toneStatus?.editCount ?? 0) < 3 ? 'Need at least 3 human edits to generate a tone guide' : 'Regenerate tone guide from all human edits'}
            style={{
              background: toneRefreshing ? 'var(--surface)' : '#1f6feb',
              color: toneRefreshing ? 'var(--muted)' : '#fff',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '0.3rem 0.85rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: (toneRefreshing || (toneStatus?.editCount ?? 0) < 3) ? 'not-allowed' : 'pointer',
              opacity: (toneRefreshing || (toneStatus?.editCount ?? 0) < 3) ? 0.6 : 1,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              marginLeft: '1rem',
            }}
          >
            {toneRefreshing ? '⏳ Refreshing…' : '↺ Refresh now'}
          </button>
        </div>

        {/* Status metadata */}
        <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>
            Edit pairs: <strong>{toneStatusLoading ? '…' : (toneStatus?.editCount ?? 0)}</strong>
          </span>
          {toneStatus?.toneGuideUpdatedAt && (
            <span style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>
              Last refreshed: <strong>{new Date(toneStatus.toneGuideUpdatedAt).toLocaleString()}</strong>
            </span>
          )}
        </div>

        {/* Error banner */}
        {toneStatus?.lastError && (
          <div style={{
            background: 'rgba(248, 81, 73, 0.1)',
            border: '1px solid rgba(248, 81, 73, 0.3)',
            borderRadius: 6,
            padding: '0.5rem 0.75rem',
            marginBottom: '0.75rem',
            fontSize: '0.8rem',
            color: '#f85149',
          }}>
            <strong>Last refresh failed</strong>
            {toneStatus.lastErrorAt && (
              <span style={{ color: 'var(--muted)', marginLeft: '0.5rem' }}>
                ({new Date(toneStatus.lastErrorAt).toLocaleString()})
              </span>
            )}
            <div style={{ marginTop: '0.25rem', fontFamily: 'monospace', wordBreak: 'break-word' }}>
              {toneStatus.lastError}
            </div>
          </div>
        )}

        {/* Success/failure message from manual refresh */}
        {toneRefreshMsg && (
          <div style={{
            background: toneRefreshMsg.ok ? 'rgba(46, 160, 67, 0.1)' : 'rgba(248, 81, 73, 0.1)',
            border: `1px solid ${toneRefreshMsg.ok ? 'rgba(46, 160, 67, 0.3)' : 'rgba(248, 81, 73, 0.3)'}`,
            borderRadius: 6,
            padding: '0.5rem 0.75rem',
            marginBottom: '0.75rem',
            fontSize: '0.8rem',
            color: toneRefreshMsg.ok ? '#3fb950' : '#f85149',
          }}>
            {toneRefreshMsg.text}
          </div>
        )}

        {/* Learned bullets */}
        {toneStatusLoading ? (
          <p style={{ fontSize: '0.85rem', color: 'var(--muted)', margin: 0 }}>Loading…</p>
        ) : (toneStatus?.toneGuide?.length ?? 0) > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            {toneStatus!.toneGuide.map((bullet, i) => (
              <div key={i} style={{ fontSize: '0.875rem' }}>• {bullet}</div>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: '0.85rem', color: 'var(--muted)', margin: 0 }}>
            {(toneStatus?.editCount ?? 0) < 3
              ? `No tone guide yet — need ${3 - (toneStatus?.editCount ?? 0)} more human edits to generate one.`
              : 'No tone guide generated yet. Click "Refresh now" to generate one from your edit history.'}
          </p>
        )}
      </div>

      {/* Allowed + Restricted side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
        <DashCard title="Allowed" {...mk('allowed')} onSave={() => saveSection('allowed', { allowed })} compact>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '0.6rem' }}>
            {allowed.map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ flex: 1, fontSize: '0.85rem', color: '#3fb950' }}>✓ {item}</span>
                <button onClick={() => setAllowed(allowed.filter((_, j) => j !== i))} style={removeTagBtnStyle}>×</button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <input
              value={allowedInput}
              onChange={(e) => setAllowedInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && allowedInput.trim()) { setAllowed([...allowed, allowedInput.trim()]); setAllowedInput(''); } }}
              placeholder="Add permitted action…"
              style={{ ...inputStyle, flex: 1, fontSize: '0.85rem' }}
            />
            <button
              onClick={() => { if (allowedInput.trim()) { setAllowed([...allowed, allowedInput.trim()]); setAllowedInput(''); } }}
              disabled={!allowedInput.trim()}
              style={{ ...fetchBtnStyle, padding: '0.4rem 0.6rem', fontSize: '0.8rem' }}
            >
              +
            </button>
          </div>
        </DashCard>

        <DashCard title="Restricted" {...mk('restricted')} onSave={() => saveSection('restricted', { restricted })} compact>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '0.6rem' }}>
            {restricted.map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ flex: 1, fontSize: '0.85rem', color: '#f85149' }}>✗ {item}</span>
                <button onClick={() => setRestricted(restricted.filter((_, j) => j !== i))} style={removeTagBtnStyle}>×</button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <input
              value={restrictedInput}
              onChange={(e) => setRestrictedInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && restrictedInput.trim()) { setRestricted([...restricted, restrictedInput.trim()]); setRestrictedInput(''); } }}
              placeholder="Add restriction…"
              style={{ ...inputStyle, flex: 1, fontSize: '0.85rem' }}
            />
            <button
              onClick={() => { if (restrictedInput.trim()) { setRestricted([...restricted, restrictedInput.trim()]); setRestrictedInput(''); } }}
              disabled={!restrictedInput.trim()}
              style={{ ...fetchBtnStyle, padding: '0.4rem 0.6rem', fontSize: '0.8rem' }}
            >
              +
            </button>
          </div>
        </DashCard>
      </div>

      {/* Competitors */}
      <DashCard title="Competitors" {...mk('competitors')} onSave={() => saveSection('competitors', { competitors })}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem', marginBottom: '0.75rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
              <th style={{ padding: '0.3rem 0.5rem', fontSize: '0.78rem', color: 'var(--muted)', fontWeight: 600, width: '25%' }}>Name</th>
              <th style={{ padding: '0.3rem 0.5rem', fontSize: '0.78rem', color: 'var(--muted)', fontWeight: 600, width: '30%' }}>URL</th>
              <th style={{ padding: '0.3rem 0.5rem', fontSize: '0.78rem', color: 'var(--muted)', fontWeight: 600 }}>Notes</th>
              <th style={{ width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {competitors.map((c, i) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '0.3rem 0.5rem' }}>
                  <input
                    value={c.name}
                    onChange={(e) => setCompetitors(competitors.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                    style={{ ...inputStyle, fontSize: '0.85rem', padding: '0.25rem 0.4rem' }}
                  />
                </td>
                <td style={{ padding: '0.3rem 0.5rem' }}>
                  <input
                    value={c.url ?? ''}
                    onChange={(e) => setCompetitors(competitors.map((x, j) => j === i ? { ...x, url: e.target.value } : x))}
                    placeholder="https://…"
                    style={{ ...inputStyle, fontSize: '0.85rem', padding: '0.25rem 0.4rem' }}
                  />
                </td>
                <td style={{ padding: '0.3rem 0.5rem' }}>
                  <input
                    value={c.notes}
                    onChange={(e) => setCompetitors(competitors.map((x, j) => j === i ? { ...x, notes: e.target.value } : x))}
                    placeholder="Key differentiators…"
                    style={{ ...inputStyle, fontSize: '0.85rem', padding: '0.25rem 0.4rem' }}
                  />
                </td>
                <td style={{ padding: '0.3rem 0.25rem', textAlign: 'center' }}>
                  <button onClick={() => setCompetitors(competitors.filter((_, j) => j !== i))} style={removeTagBtnStyle}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          onClick={() => setCompetitors([...competitors, { name: '', url: '', notes: '' }])}
          style={{ ...fetchBtnStyle, fontSize: '0.82rem', padding: '0.35rem 0.75rem' }}
        >
          + Add Competitor
        </button>
      </DashCard>

      {/* Model & Keys */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '1rem 1.25rem',
        marginBottom: '1rem',
      }}>
        <div style={{ fontSize: '0.78rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: '0.75rem' }}>
          Model & Keys
        </div>
        <SharedFields
          model={model} setModel={setModel}
          apiKey={apiKey} setApiKey={setApiKey}
          hasApiKey={agent.hasApiKey}
          telegramKey={telegramKey} setTelegramKey={setTelegramKey}
          telegramChatId={telegramChatId} setTelegramChatId={setTelegramChatId}
        />
        <button
          onClick={onSaveModelKeys}
          disabled={saving}
          style={{ ...saveBtnStyle, background: saved ? '#238636' : '#1f6feb', opacity: saving ? 0.7 : 1 }}
        >
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
        </button>
      </div>

      <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
        💡 Looking to completely repurpose this agent? We recommend creating a new agent from scratch — it keeps memory, flows, and schedules clean.
      </p>
    </div>
  );
}

/** A card panel for a single editable dashboard section. */
function DashCard({
  title, isSaving, isSaved, onSave, compact, children,
}: {
  title: string; isSaving: boolean; isSaved: boolean; onSave: () => void;
  compact?: boolean; children: React.ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: compact ? '0.75rem 1rem' : '1rem 1.25rem',
      marginBottom: compact ? 0 : '1rem',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>
          {title}
        </span>
        <button
          onClick={onSave}
          disabled={isSaving}
          style={{
            ...saveBtnStyle,
            background: isSaved ? '#238636' : '#1f6feb',
            padding: '0.25rem 0.75rem',
            fontSize: '0.8rem',
            opacity: isSaving ? 0.6 : 1,
          }}
        >
          {isSaving ? 'Saving…' : isSaved ? '✓ Saved' : 'Save'}
        </button>
      </div>
      {children}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────────

function RecommendationGroup({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <div style={{ marginBottom: '0.5rem' }}>
        <span style={{ fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>
          {title}
        </span>
        <span style={{ fontSize: '0.78rem', color: 'var(--muted)', marginLeft: '0.5rem' }}>{subtitle}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>{children}</div>
    </div>
  );
}

function CompanyCard({ name, summary }: { name?: string; summary: string }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1.25rem', fontSize: '0.875rem', lineHeight: 1.5 }}>
      {name && <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{name}</div>}
      <div style={{ color: 'var(--muted)' }}>{summary}</div>
    </div>
  );
}

function RecommendedFlowCard({ name, description, onCreateWithAI }: { name: string; description: string; onCreateWithAI: (description: string) => void }) {
  return (
    <div style={cardStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <code style={{ fontSize: '0.875rem', fontWeight: 600, display: 'block', marginBottom: '0.2rem' }}>{name}</code>
        <p style={{ fontSize: '0.82rem', color: 'var(--muted)', margin: 0 }}>{description}</p>
      </div>
      <button onClick={() => onCreateWithAI(`Build a flow called "${name}": ${description}`)} style={createAiBtnStyle}>
        Create with AI
      </button>
    </div>
  );
}

function RecommendedDatabaseCard({ name, description, columns, agentId }: { name: string; description: string; columns: { name: string; type: string }[]; agentId: string }) {
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    setCreating(true);
    setError('');
    try {
      await api.createTable(agentId, { name, columns: JSON.stringify(columns) });
      setCreated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create table');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={cardStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <code style={{ fontSize: '0.875rem', fontWeight: 600, display: 'block', marginBottom: '0.2rem' }}>{name}</code>
        <p style={{ fontSize: '0.82rem', color: 'var(--muted)', margin: '0 0 0.35rem' }}>{description}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
          {columns.map((col) => (
            <span key={col.name} style={colPillStyle}>{col.name} <span style={{ opacity: 0.6 }}>{col.type}</span></span>
          ))}
        </div>
        {error && <p style={{ fontSize: '0.78rem', color: 'var(--error)', margin: '0.3rem 0 0' }}>{error}</p>}
      </div>
      <button
        onClick={() => void handleCreate()}
        disabled={creating || created}
        style={{ ...createDbBtnStyle, background: created ? '#238636' : '#1f6feb', opacity: creating ? 0.6 : 1, cursor: creating || created ? 'default' : 'pointer' }}
      >
        {creating ? '…' : created ? '✓ Created' : 'Create table'}
      </button>
    </div>
  );
}

function RecommendedScheduleCard({ flowName, cron, label, input, agentId }: { flowName: string; cron: string; label: string; input: string; agentId: string }) {
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    setCreating(true);
    setError('');
    try {
      await api.createSchedule(agentId, { cron, input, enabled: false, timezone: 'Europe/Stockholm' });
      setCreated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create schedule');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={cardStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
          <code style={{ fontSize: '0.875rem', fontWeight: 600 }}>{flowName}</code>
          <span style={schedLabelStyle}>{label}</span>
          <code style={{ fontSize: '0.75rem', color: 'var(--muted)', opacity: 0.8 }}>{cron}</code>
        </div>
        <p style={{ fontSize: '0.82rem', color: 'var(--muted)', margin: 0 }}>{input}</p>
        {created && <p style={{ fontSize: '0.75rem', color: 'var(--muted)', margin: '0.3rem 0 0' }}>Disabled by default — enable in the Schedule tab once the flow is built.</p>}
        {error && <p style={{ fontSize: '0.78rem', color: 'var(--error)', margin: '0.3rem 0 0' }}>{error}</p>}
      </div>
      <button
        onClick={() => void handleCreate()}
        disabled={creating || created}
        style={{ ...createDbBtnStyle, background: created ? '#238636' : '#1f6feb', opacity: creating ? 0.6 : 1, cursor: creating || created ? 'default' : 'pointer' }}
      >
        {creating ? '…' : created ? '✓ Created' : 'Create schedule'}
      </button>
    </div>
  );
}

function SharedFields({ model, setModel, apiKey, setApiKey, hasApiKey, telegramKey, setTelegramKey, telegramChatId, setTelegramChatId }: {
  model: string; setModel: (v: string) => void;
  apiKey: string; setApiKey: (v: string) => void;
  hasApiKey: boolean;
  telegramKey: string; setTelegramKey: (v: string) => void;
  telegramChatId: string; setTelegramChatId: (v: string) => void;
}) {
  return (
    <>
      <Field label="Model">
        <select value={model} onChange={(e) => setModel(e.target.value)} style={inputStyle}>
          {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <Field label={`Anthropic API Key ${hasApiKey ? '(set — leave blank to keep)' : ''}`}>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasApiKey ? '••••••••••••••••' : 'sk-ant-...'} style={inputStyle} />
      </Field>
      <Field label="Telegram Bot Token (optional)">
        <input type="password" value={telegramKey} onChange={(e) => setTelegramKey(e.target.value)} placeholder="Leave blank to keep existing" style={inputStyle} />
      </Field>
      <Field label="Telegram Chat ID (optional)">
        <input value={telegramChatId} onChange={(e) => setTelegramChatId(e.target.value)} placeholder="-100123456789" style={inputStyle} />
      </Field>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '0.4rem' }}>{label}</label>
      {children}
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text)',
  padding: '0.5rem 0.75rem',
  fontSize: '0.9rem',
  boxSizing: 'border-box',
};

const fetchBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text)',
  padding: '0.5rem 1rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const generateBtnStyle: React.CSSProperties = {
  background: 'linear-gradient(135deg, #238636, #1a6a2a)',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '0.65rem 1.5rem',
  fontSize: '0.9rem',
  fontWeight: 600,
  width: '100%',
  marginTop: '0.25rem',
};

const saveBtnStyle: React.CSSProperties = {
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '0.6rem 1.5rem',
  fontSize: '0.9rem',
  fontWeight: 500,
  cursor: 'pointer',
};

const toggleBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--muted)',
  padding: '0.3rem 0.75rem',
  fontSize: '0.8rem',
  cursor: 'pointer',
};

const backBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--muted)',
  padding: '0.3rem 0.75rem',
  fontSize: '0.8rem',
  cursor: 'pointer',
};

const cancelBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--muted)',
  padding: '0.6rem 1rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
};

const amendBtnStyle: React.CSSProperties = {
  background: 'linear-gradient(135deg, #1f6feb, #1158c7)',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '0.6rem 1.5rem',
  fontSize: '0.9rem',
  fontWeight: 500,
  cursor: 'pointer',
  width: '100%',
};

const cardStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '0.875rem 1rem',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '1rem',
};

const createAiBtnStyle: React.CSSProperties = {
  background: '#238636',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '0.4rem 0.9rem',
  fontSize: '0.82rem',
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

const createDbBtnStyle: React.CSSProperties = {
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '0.4rem 0.9rem',
  fontSize: '0.82rem',
  fontWeight: 500,
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

const colPillStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  padding: '0.1rem 0.45rem',
  borderRadius: 4,
  background: '#58a6ff18',
  border: '1px solid #58a6ff33',
  color: '#58a6ff',
  fontFamily: 'monospace',
};

const schedLabelStyle: React.CSSProperties = {
  fontSize: '0.72rem',
  padding: '0.1rem 0.45rem',
  borderRadius: 10,
  background: '#f0883e22',
  border: '1px solid #f0883e44',
  color: '#f0883e',
};

const removeTagBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--muted)',
  cursor: 'pointer',
  fontSize: '1rem',
  lineHeight: 1,
  padding: '0 0.25rem',
  flexShrink: 0,
};
