import { useState, useEffect } from 'react';
import { api } from '../../api/client.js';
import type { Agent, Flow, FlowStep, FlowInput, Tool, FlowTestResult } from '../../types/index.js';
import FlowGenerator, { type GeneratorMessage } from './FlowGenerator.js';
import { FlowMasterPanel } from '../../components/flow-editor/FlowMasterPanel.js';
import { TOOL_OUTPUTS } from '../../components/flow-editor/InputMappingField.js';
import { StepCard } from '../../components/flow-editor/StepCard.js';
import { FlowMetadata } from '../../components/flow-editor/FlowMetadata.js';
import { DedupSettings } from '../../components/flow-editor/DedupSettings.js';
import { ReturnStepSelector } from '../../components/flow-editor/ReturnStepSelector.js';
import { ToolPickerModal } from '../../components/flow-editor/ToolPickerModal.js';
import { TestPanel } from '../../components/flow-editor/TestPanel.js';
import { useFlowEditorState, type FlowDraft } from '../../hooks/useFlowEditorState.js';
import { card, sectionTitle, labelStyle, inputStyle, textareaStyle, selectStyle, primaryBtn, actionBtn } from '../../components/flow-editor/styles.js';
import { InsertStepBar } from '../../components/flow-editor/InsertStepBar.js';
import { FlowDiagram } from '../../components/flow-editor/FlowDiagram.js';
import { parseSchema, detectFlowInputKeys, buildAutoKey } from '../../components/flow-editor/flow-editor-utils.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  agent: Agent;
  flow: Flow | null;
  prefill?: FlowInput;
  onSave: (saved: Flow) => void;
  /** Called when the editor closes without saving. Receives the flow version that
   *  was fetched from the DB on mount (or null for brand-new flows) so the parent
   *  can sync its own state without an extra network round-trip. */
  onCancel: (refreshedFlow: Flow | null) => void;
}


// ── Main editor ───────────────────────────────────────────────────────────────

export default function FlowEditor({ agent, flow, prefill, onSave, onCancel }: Props) {
  const [draft, dispatch] = useFlowEditorState(flow, prefill);
  const [agentTools, setAgentTools] = useState<Tool[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch fresh flow from DB on mount ─────────────────────────────────────
  // Never trust the prop — always pull the authoritative version from the DB
  // so that debugger edits are visible immediately.
  const [dbFetchState, setDbFetchState] = useState<'loading' | 'done' | 'error'>(
    flow !== null ? 'loading' : 'done'
  );
  const [dbFetchError, setDbFetchError] = useState<string | null>(null);
  // The authoritative DB version fetched on mount — passed back to the parent on close.
  const [fetchedFlow, setFetchedFlow] = useState<Flow | null>(null);

  const fetchFromDb = () => {
    if (flow === null) return;
    setDbFetchState('loading');
    setDbFetchError(null);
    api.getFlow(agent.id, flow.id)
      .then((fetched) => {
        dispatch({ type: 'REINIT', flow: fetched });
        setFetchedFlow(fetched);
        setDbFetchState('done');
      })
      .catch((err: unknown) => {
        setDbFetchError(err instanceof Error ? err.message : 'Failed to load flow from server');
        setDbFetchState('error');
      });
  };

  // Run once on mount when editing an existing flow
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fetchFromDb, []);

  const [testInput, setTestInput] = useState('{}');
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<FlowTestResult | null>(null);
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set());
  const [fixMode, setFixMode] = useState(false);
  const [fixMessages, setFixMessages] = useState<GeneratorMessage[]>([]);
  const [fixApplied, setFixApplied] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerInsertAt, setPickerInsertAt] = useState<number | null>(null);
  const [idCopied, setIdCopied] = useState(false);
  const [fmPrefill, setFmPrefill] = useState<string | null>(null);
  const [repullLoading, setRepullLoading] = useState(false);
  const [repullUpdated, setRepullUpdated] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  const handleDiagramSelectStep = (stepId: string) => {
    setSelectedStepId(stepId);
    // Scroll the corresponding step card into view
    requestAnimationFrame(() => {
      document.getElementById(`step-card-${stepId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  const handleRepull = () => {
    if (flow === null) return;
    setRepullLoading(true);
    setRepullUpdated(false);
    api.getFlow(agent.id, flow.id)
      .then((fetched) => {
        dispatch({ type: 'REINIT', flow: fetched });
        setRepullUpdated(true);
        setTimeout(() => setRepullUpdated(false), 2500);
      })
      .catch((err: unknown) => {
        alert(`Repull failed: ${err instanceof Error ? err.message : 'Failed to reload from server'}`);
      })
      .finally(() => setRepullLoading(false));
  };

  useEffect(() => { api.getTools(agent.id).then(setAgentTools).catch(console.error); }, [agent.id]);

  const detectedKeys = detectFlowInputKeys(draft.steps);

  useEffect(() => {
    if (detectedKeys.length === 0) return;
    setTestInput((prev) => {
      try {
        const current = JSON.parse(prev) as Record<string, unknown>;
        const merged: Record<string, string> = {};
        for (const k of detectedKeys) merged[k] = String(current[k] ?? '');
        return JSON.stringify(merged, null, 2);
      } catch {
        return JSON.stringify(Object.fromEntries(detectedKeys.map((k) => [k, ''])), null, 2);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectedKeys.join(',')]);

  const addStep = (tool: Tool, insertAt: number | null) => {
    const inputMapping: FlowStep['inputMapping'] = {};
    const schema = parseSchema(tool.inputSchema);
    if ('tabId' in schema) {
      const insertBefore = insertAt ?? draft.steps.length;
      const tabIdSource = [...draft.steps.slice(0, insertBefore)].reverse().find((s) => {
        const toolName = agentTools.find((t) => t.id === s.toolId)?.name ?? '';
        return (TOOL_OUTPUTS[toolName] ?? []).includes('tabId');
      });
      if (tabIdSource) inputMapping.tabId = { type: 'step_ref', stepId: tabIdSource.id, path: 'tabId' };
    }
    dispatch({ type: 'ADD_STEP', step: { id: crypto.randomUUID(), toolId: tool.id, label: tool.name, inputMapping }, insertAt });
    setPickerOpen(false);
    setPickerInsertAt(null);
  };

  const addSpecialStep = (toolId: string, label: string, im: FlowStep['inputMapping'], insertAt: number | null) => {
    const extra =
      toolId === '__evaluate__' ? { evaluate: { prompt: 'Did the previous action complete successfully?' } } :
      toolId === '__transform__' ? { transform: { script: '// Access your inputs via the input object\n// e.g. return input.url.trim();\nreturn input;' } } :
      {};
    dispatch({ type: 'ADD_STEP', step: { id: crypto.randomUUID(), toolId, label, inputMapping: im, ...extra }, insertAt });
  };

  const handlePasteFromExtension = async (insertAt: number) => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      alert('Could not read clipboard. Make sure the extension Runner ran a step successfully first.');
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      alert('Clipboard does not contain a valid AgentSpawner step. Run a step in the extension Runner tab first.');
      return;
    }
    if (!payload.__agentspawner_step__) {
      alert('Clipboard does not contain an AgentSpawner step. Run a step in the extension Runner tab and click "Copy step".');
      return;
    }
    const toolName = payload.toolName as string;
    const fields = (payload.fields ?? {}) as Record<string, unknown>;
    const tool = agentTools.find((t) => t.name === toolName);
    if (!tool) {
      alert(`Tool "${toolName}" is not installed on this agent. Add it first in the agent's tool settings.`);
      return;
    }
    const inputMapping: FlowStep['inputMapping'] = {};
    for (const [k, v] of Object.entries(fields)) {
      inputMapping[k] = { type: 'literal', value: v };
    }
    dispatch({ type: 'ADD_STEP', step: { id: crypto.randomUUID(), toolId: tool.id, label: tool.name, inputMapping }, insertAt });
  };

  const handleSave = async () => {
    if (!draft.name.match(/^[a-z_][a-z0-9_]*$/)) { setError('Name must be snake_case'); return; }
    if (!draft.description.trim()) { setError('Description is required'); return; }
    setSaving(true); setError(null);
    try {
      const computedInputSchema = JSON.stringify({ type: 'object', properties: Object.fromEntries(detectedKeys.map((k) => [k, { type: 'string', description: draft.inputDescriptions[k] ?? '' }])), ...(detectedKeys.length > 0 && { required: detectedKeys }) });
      let returnStepId: string | null = null, returnStepsJson: string | null = null;
      if (draft.returnStepIds.length === 1) returnStepId = draft.returnStepIds[0]!;
      else if (draft.returnStepIds.length > 1) returnStepsJson = JSON.stringify(draft.returnStepIds.map((id) => ({ key: buildAutoKey(id, draft.steps, draft.returnStepKeys), stepId: id })));
      const payload: FlowInput = { name: draft.name, description: draft.description, inputSchema: computedInputSchema, steps: draft.steps, returnStepId, returnSteps: returnStepsJson, reasoningModel: draft.reasoningModel || null, reasoningPrompt: draft.reasoningPrompt.trim() || null, resultMessage: draft.resultMessage.trim() || null, flowType: draft.flowType ?? null, dedupKeyField: draft.dedupKeyField.trim() || null, dedupBreakType: draft.dedupBreakType ?? null, dedupIntervalHours: draft.dedupIntervalHours ? parseInt(draft.dedupIntervalHours, 10) || null : null, dedupBlockMessage: draft.dedupBlockMessage.trim() || null, readsFrom: draft.readsFrom.trim() || null, writesTo: draft.writesTo.trim() || null, updatesFields: draft.updatesFields.trim() ? draft.updatesFields.split(',').map((f) => f.trim()).filter(Boolean) : null, requiresApproval: draft.requiresApproval, requiresHumanReview: draft.requiresHumanReview };
      const saved = flow ? await api.updateFlow(agent.id, flow.id, payload) : await api.createFlow(agent.id, payload);
      onSave(saved);
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed'); } finally { setSaving(false); }
  };

  const handleTest = async () => {
    setTestRunning(true); setTestResult(null);
    try {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(testInput) as Record<string, unknown>; } catch { /* empty */ }
      const computedInputSchema = JSON.stringify({ type: 'object', properties: Object.fromEntries(detectedKeys.map((k) => [k, { type: 'string', description: draft.inputDescriptions[k] ?? '' }])), ...(detectedKeys.length > 0 && { required: detectedKeys }) });
      const testReturnStepId = draft.returnStepIds.length === 1 ? draft.returnStepIds[0] ?? null : null;
      const testReturnSteps = draft.returnStepIds.length > 1 ? JSON.stringify(draft.returnStepIds.map((id) => ({ key: buildAutoKey(id, draft.steps, draft.returnStepKeys), stepId: id }))) : null;
      const res = await api.testFlowInline(agent.id, draft.steps, computedInputSchema, testReturnStepId, testReturnSteps, input, draft.resultMessage.trim() || null);
      setTestResult(res);
    } catch (err) { setTestResult({ ok: false, stepResults: {}, durationMs: 0, error: (err as Error).message }); } finally { setTestRunning(false); }
  };

  const openStepFix = (targetStep: FlowStep) => {
    if (!testResult) return;
    const targetIdx = draft.steps.indexOf(targetStep);
    const tool = agentTools.find((t) => t.id === targetStep.toolId);
    const res = testResult.stepResults[targetStep.id];
    const priorLines = draft.steps.slice(0, targetIdx).map((s, i) => {
      const tn = agentTools.find((t) => t.id === s.toolId)?.name ?? s.toolId;
      const r = testResult.stepResults[s.id];
      const rs = r === undefined ? '(not reached)' : r === null ? 'null' : (() => { const j = JSON.stringify(r); return j.length > 120 ? j.slice(0, 120) + '…' : j; })();
      return `  Step ${i + 1} "${s.label}" (${tn}): ${rs}`;
    });
    const inputMappingLines = Object.entries(targetStep.inputMapping).map(([field, expr]) => {
      if (expr.type === 'literal') return `  ${field}: ${JSON.stringify(expr.value).slice(0, 200)}`;
      if (expr.type === 'flow_input') return `  ${field}: flow_input(${expr.key})`;
      if (expr.type === 'step_ref') { const refLabel = draft.steps.find((s) => s.id === expr.stepId)?.label ?? expr.stepId; return `  ${field}: step_ref("${refLabel}".${expr.path})`; }
      return `  ${field}: ?`;
    });
    const resStr = res === null ? 'null' : res === undefined ? '(not reached)' : JSON.stringify(res).slice(0, 300);
    const contextMsg = `Flow "${draft.name}": ${draft.description}\nTest input: ${testInput}\n\n` + (priorLines.length > 0 ? `Prior step results:\n${priorLines.join('\n')}\n\n` : '') + `Broken step: Step ${targetIdx + 1} "${targetStep.label}" (${tool?.name ?? targetStep.toolId})\nResult: ${resStr}\nInputs used:\n${inputMappingLines.join('\n')}\n\nFix this step. Do NOT call inspect_page — work from the data above.\nFirst write 2-3 sentences explaining what was wrong and exactly what you changed, then call submit_flow with the corrected flow.`;
    setFixMessages([{ role: 'user', content: contextMsg }]);
    setFixMode(true);
  };

  const openFeedbackFix = () => {
    if (!feedbackText.trim()) return;
    const stepSummary = draft.steps.map((s, i) => {
      const toolName = agentTools.find((t) => t.id === s.toolId)?.name ?? s.toolId;
      const inputs = Object.entries(s.inputMapping).map(([field, expr]) => {
        if (expr.type === 'literal') return `${field}: ${JSON.stringify(expr.value).slice(0, 120)}`;
        if (expr.type === 'flow_input') return `${field}: flow_input(${expr.key})`;
        if (expr.type === 'step_ref') { const refLabel = draft.steps.find((st) => st.id === expr.stepId)?.label ?? expr.stepId; return `${field}: step_ref("${refLabel}"${expr.path ? '.' + expr.path : ''})`; }
        return `${field}: ?`;
      }).join(', ');
      return `  ${i + 1}. "${s.label}" (${toolName})${inputs ? ': ' + inputs : ''}`;
    }).join('\n');
    const contextMsg = `Flow "${draft.name}": ${draft.description}\n\nCurrent steps:\n${stepSummary}\n\nFeedback: ${feedbackText.trim()}\n\nFix the flow based on this feedback. If appropriate, add a verification step. Explain what you changed in 2-3 sentences, then call submit_flow with the corrected flow.`;
    setFeedbackOpen(false); setFeedbackText('');
    setFixMessages([{ role: 'user', content: contextMsg }]);
    setFixMode(true);
  };

  // ── DB fetch loading / error screens ──────────────────────────────────────
  if (dbFetchState === 'loading') {
    return (
      <div style={{ padding: '3rem 2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', color: 'var(--muted)', height: '100%' }}>
        <div style={{ fontSize: '1.5rem', animation: 'spin 1s linear infinite' }}>↻</div>
        <p style={{ fontSize: '0.9rem', margin: 0 }}>Loading flow from server…</p>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (dbFetchState === 'error') {
    return (
      <div style={{ padding: '3rem 2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', height: '100%' }}>
        <p style={{ color: 'var(--error)', fontSize: '0.9rem', margin: 0 }}>
          ⚠ Could not load flow: {dbFetchError}
        </p>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button onClick={fetchFromDb} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 1rem', fontSize: '0.875rem', cursor: 'pointer' }}>
            Retry
          </button>
          <button onClick={() => onCancel(fetchedFlow)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '0.4rem 1rem', fontSize: '0.875rem', color: 'var(--muted)', cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (fixMode) {
    return (
      <FlowGenerator agent={agent} initialMessages={fixMessages} autoSend confirmOnFlow title="Fix Flow with AI" loadingText="Analysing test results… (10–30s)"
        flowType={draft.flowType === 'scrape' || draft.flowType === 'action' ? draft.flowType : undefined}
        onFlow={(def) => { dispatch({ type: 'APPLY_FIX', def }); setTestResult(null); setExpandedResults(new Set()); setFixMode(false); setFixApplied(true); }}
        onCancel={() => setFixMode(false)} />
    );
  }

  const onUpdate = (patch: Partial<FlowDraft>) => dispatch({ type: 'PATCH', patch });

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
    {/* ── Main editor column ───────────────────────────────────────────── */}
    <div style={{ flex: '0 0 60%', minWidth: 0, padding: '1.5rem', overflowY: 'auto', height: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: feedbackOpen ? '1rem' : '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>{flow ? 'Edit Flow' : 'New Flow'}</h3>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={() => setFeedbackOpen((v) => !v)} style={{ ...actionBtn, color: feedbackOpen ? 'var(--text)' : 'var(--muted)', borderColor: feedbackOpen ? '#6f42c1' : undefined }}>✦ Fix with AI</button>
          {flow && (
            <button
              onClick={handleRepull}
              disabled={repullLoading}
              title="Re-fetch this flow from the database"
              style={{
                ...actionBtn,
                color: repullUpdated ? '#3fb950' : 'var(--muted)',
                borderColor: repullUpdated ? '#3fb95055' : undefined,
                opacity: repullLoading ? 0.6 : 1,
                cursor: repullLoading ? 'default' : 'pointer',
                minWidth: 72,
              }}
            >
              {repullLoading ? '⏳ Pulling…' : repullUpdated ? '✓ Updated' : '↺ Repull'}
            </button>
          )}
          <button onClick={() => onCancel(fetchedFlow)} style={actionBtn}>Cancel</button>
          <button onClick={() => void handleSave()} disabled={saving} style={primaryBtn}>{saving ? 'Saving…' : 'Save Flow'}</button>
        </div>
      </div>

      {flow && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', fontSize: '0.78rem', color: 'var(--muted)' }}>
          <span>Flow ID: {flow.id}</span>
          <button
            onClick={() => { void navigator.clipboard.writeText(flow.id); setIdCopied(true); setTimeout(() => setIdCopied(false), 2000); }}
            style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--muted)', cursor: 'pointer', fontSize: '0.75rem', padding: '0.1rem 0.4rem', lineHeight: 1.4 }}
            title="Copy flow ID"
          >
            {idCopied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      )}

      {feedbackOpen && (
        <div style={{ background: 'var(--surface)', border: '1px solid #6f42c155', borderRadius: 8, padding: '1rem', marginBottom: '1.5rem' }}>
          <p style={{ fontSize: '0.82rem', color: 'var(--muted)', marginBottom: '0.5rem' }}>Describe what's not working. The AI will see all steps and fix the flow.</p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <textarea autoFocus value={feedbackText} onChange={(e) => setFeedbackText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) openFeedbackFix(); }} placeholder="e.g. The click on the reply button isn't working — the selector seems wrong." rows={2} style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.875rem', resize: 'none' }} />
            <button onClick={openFeedbackFix} disabled={!feedbackText.trim()} style={{ background: '#6f42c1', color: '#fff', border: 'none', borderRadius: 6, padding: '0 1rem', fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap', alignSelf: 'stretch' }}>Fix →</button>
          </div>
        </div>
      )}

      {fixApplied && (
        <div style={{ background: '#23863622', border: '1px solid #23863655', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem', color: '#3fb950', fontSize: '0.875rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          ✓ Fix applied — review the changes below and run the test again to verify.
          <button onClick={() => setFixApplied(false)} style={{ background: 'none', border: 'none', color: '#3fb950', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}>✕</button>
        </div>
      )}

      {error && <div style={{ background: '#f8514922', border: '1px solid #f8514955', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem', color: 'var(--error)', fontSize: '0.875rem' }}>{error}</div>}

      <FlowMetadata name={draft.name} description={draft.description} flowType={draft.flowType} readsFrom={draft.readsFrom} writesTo={draft.writesTo} updatesFields={draft.updatesFields} requiresApproval={draft.requiresApproval} onUpdate={onUpdate} />

      {draft.flowType === 'action' && (
        <DedupSettings dedupKeyField={draft.dedupKeyField} dedupBreakType={draft.dedupBreakType} dedupIntervalHours={draft.dedupIntervalHours} dedupBlockMessage={draft.dedupBlockMessage} onUpdate={onUpdate} />
      )}

      {/* Flow Inputs */}
      <section style={card}>
        <h4 style={sectionTitle}>Flow Inputs</h4>
        {detectedKeys.length === 0 ? (
          <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>No inputs detected yet. Use <code style={{ color: 'var(--accent)' }}>{'{{key}}'}</code> inside a Literal field or a <strong>Flow Input</strong> expression in any step — keys appear here automatically.</p>
        ) : (
          <>
            <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.75rem' }}>Add a description so the AI knows what value to pass in.</p>
            {detectedKeys.map((key) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                <code style={{ fontSize: '0.85rem', color: 'var(--accent)', minWidth: 120, flexShrink: 0 }}>{'{{'}{key}{'}}'}</code>
                <input value={draft.inputDescriptions[key] ?? ''} onChange={(e) => dispatch({ type: 'SET_INPUT_DESCRIPTION', key, value: e.target.value })} placeholder={`Describe what "${key}" means so the AI knows what to pass`} style={{ ...inputStyle, flex: 1 }} />
              </div>
            ))}
          </>
        )}
      </section>

      {/* Response Model */}
      <section style={card}>
        <h4 style={sectionTitle}>Response Model</h4>
        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.75rem' }}>If set, this model writes the final answer directly into the chat. The main agent stays silent — saving time and cost.</p>
        <div style={{ marginBottom: '1rem' }}>
          <label style={labelStyle}>Model</label>
          <select value={draft.reasoningModel ?? ''} onChange={(e) => onUpdate({ reasoningModel: e.target.value || null })} style={{ ...selectStyle, width: '100%' }}>
            <option value="">None — main agent writes the response</option>
            <option value="claude-haiku-4-5-20251001">Haiku (fast &amp; cheap)</option>
            <option value="claude-sonnet-4-6">Sonnet (same as main agent)</option>
          </select>
        </div>
        {draft.reasoningModel && (
          <div>
            <label style={labelStyle}>System Prompt for {draft.reasoningModel.includes('haiku') ? 'Haiku' : 'Sonnet'} (optional)</label>
            <textarea value={draft.reasoningPrompt} onChange={(e) => onUpdate({ reasoningPrompt: e.target.value })} rows={3} placeholder="Leave blank to use the agent's own system prompt." style={{ ...textareaStyle, fontSize: '0.875rem' }} />
          </div>
        )}
      </section>

      {/* Result Message */}
      <section style={card}>
        <h4 style={sectionTitle}>Result Message</h4>
        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.75rem' }}>Optional message sent to the AI along with the flow's data. Use <code style={{ fontSize: '0.78rem' }}>{'{{result}}'}</code> to place the data inline.</p>
        <textarea value={draft.resultMessage} onChange={(e) => onUpdate({ resultMessage: e.target.value })} rows={3} placeholder={`e.g. Here is the scraped data. Cross-reference with memory and update the database if the user's status has changed.`} style={{ ...textareaStyle, fontSize: '0.875rem' }} />
      </section>

      {/* Steps */}
      <section style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <h4 style={{ ...sectionTitle, margin: 0 }}>Steps ({draft.steps.length})</h4>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={() => addSpecialStep('__evaluate__', 'Evaluate', {}, null)} style={{ ...primaryBtn, background: 'transparent', color: '#8b949e', border: '1px solid var(--border)' }}>🔍 Add Evaluate</button>
            <button onClick={() => { setPickerInsertAt(null); setPickerOpen(true); }} disabled={agentTools.length === 0} style={primaryBtn}>+ Add Step</button>
          </div>
        </div>
        <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '1rem' }}>ℹ Need a CSS selector? Click the <strong>AgentSpawner extension</strong> icon in your browser toolbar.</p>
        {agentTools.length === 0 && <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>No tools found for this agent. Add tools first.</p>}

        {draft.steps.length > 1 && (
          <FlowDiagram
            steps={draft.steps}
            agentTools={agentTools}
            requiresApproval={draft.requiresApproval}
            selectedStepId={selectedStepId}
            onSelectStep={handleDiagramSelectStep}
          />
        )}

        <ReturnStepSelector steps={draft.steps} returnStepIds={draft.returnStepIds} returnStepKeys={draft.returnStepKeys} onToggle={(stepId) => dispatch({ type: 'TOGGLE_RETURN_STEP', stepId })} onKeyChange={(stepId, key) => dispatch({ type: 'SET_RETURN_STEP_KEY', stepId, key })} />

        {draft.steps.map((step, idx) => (
          <div key={step.id} id={`step-card-${step.id}`}>
            {idx === 0 && <InsertStepBar onTool={() => { setPickerInsertAt(0); setPickerOpen(true); }} onEvaluate={() => addSpecialStep('__evaluate__', 'Evaluate', {}, 0)} disabled={agentTools.length === 0} onPaste={() => void handlePasteFromExtension(0)} />}
            <StepCard step={step} idx={idx} steps={draft.steps} agentTools={agentTools} returnStepIds={draft.returnStepIds} testResult={testResult} expandedResults={expandedResults}
              onUpdate={(patch) => dispatch({ type: 'UPDATE_STEP', idx, patch })}
              onMove={(dir) => dispatch({ type: 'MOVE_STEP', idx, dir })}
              onDuplicate={() => dispatch({ type: 'DUPLICATE_STEP', idx })}
              onRemove={() => dispatch({ type: 'REMOVE_STEP', idx })}
              onToggleReturn={() => dispatch({ type: 'TOGGLE_RETURN_STEP', stepId: step.id })}
              onToggleExpanded={(id) => setExpandedResults((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
              onFixStep={openStepFix}
              onFixWithFlowMaster={(msg) => setFmPrefill(msg)}
            />
            <InsertStepBar onTool={() => { setPickerInsertAt(idx + 1); setPickerOpen(true); }} onEvaluate={() => addSpecialStep('__evaluate__', 'Evaluate', {}, idx + 1)} disabled={agentTools.length === 0} onPaste={() => void handlePasteFromExtension(idx + 1)} />
          </div>
        ))}
      </section>

      <TestPanel flow={flow} steps={draft.steps} detectedKeys={detectedKeys} testInput={testInput} testRunning={testRunning} testResult={testResult} onTestInputChange={setTestInput} onRun={() => void handleTest()} />

      {pickerOpen && <ToolPickerModal
        agentTools={agentTools}
        onSelect={(tool) => addStep(tool, pickerInsertAt)}
        onSelectBuiltin={(toolId) => {
          addSpecialStep(toolId, toolId === '__transform__' ? 'Transform data' : 'Evaluate', {}, pickerInsertAt);
          setPickerOpen(false);
          setPickerInsertAt(null);
        }}
        onClose={() => { setPickerOpen(false); setPickerInsertAt(null); }}
      />}
    </div>
    {/* ── Flow Master panel ────────────────────────────────────────────── */}
    <FlowMasterPanel agentId={agent.id} draft={draft} prefillMessage={fmPrefill} onPrefillConsumed={() => setFmPrefill(null)} />
    </div>
  );
}
