import type { Flow, FlowStep, FlowTestResult } from '../../types/index.js';
import { card, sectionTitle, labelStyle, inputStyle, textareaStyle, preStyle, primaryBtn } from './styles.js';

interface Props {
  flow: Flow | null;
  steps: FlowStep[];
  detectedKeys: string[];
  testInput: string;
  testRunning: boolean;
  testResult: FlowTestResult | null;
  onTestInputChange: (v: string) => void;
  onRun: () => void;
}

export function TestPanel({ flow, steps, detectedKeys, testInput, testRunning, testResult, onTestInputChange, onRun }: Props) {
  return (
    <section style={card}>
      <h4 style={sectionTitle}>Test Flow</h4>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label style={labelStyle}>Flow Inputs</label>
          {detectedKeys.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {detectedKeys.map((k) => {
                let parsed: Record<string, unknown> = {};
                try { parsed = JSON.parse(testInput) as Record<string, unknown>; } catch { /* ignore */ }

                if (k === 'action_brief') {
                  let raw: Record<string, unknown> = {};
                  try { raw = typeof parsed[k] === 'string' ? JSON.parse(parsed[k] as string) : (parsed[k] as Record<string, unknown>) ?? {}; } catch { /* use defaults */ }
                  const action = (raw.action as Record<string, unknown>) ?? {};
                  const ctx = (raw.decision_context as Record<string, unknown>) ?? {};
                  const briefVals = { type: String(action.type ?? ''), reason: String(ctx.reason ?? ''), draft: String(action.draft ?? '') };
                  const updateBrief = (updated: typeof briefVals) => {
                    const assembled = {
                      action: { type: updated.type, ...(updated.draft.trim() ? { draft: updated.draft } : {}) },
                      decision_context: { reason: updated.reason, supporting_scrapes: [], memory_queries: [], database_context: [] },
                    };
                    let current: Record<string, unknown> = {};
                    try { current = JSON.parse(testInput) as Record<string, unknown>; } catch { /* ignore */ }
                    current[k] = JSON.stringify(assembled);
                    onTestInputChange(JSON.stringify(current, null, 2));
                  };
                  return (
                    <div key={k}>
                      <code style={{ fontSize: '0.8rem', color: 'var(--accent)', display: 'block', marginBottom: '0.3rem' }}>{k}</code>
                      <div style={{ border: '1px solid var(--border)', borderRadius: 5, padding: '0.4rem 0.5rem', background: 'rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                        {(['type', 'reason', 'draft'] as const).map((sub) => (
                          <div key={sub} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <label style={{ fontSize: '0.72rem', color: 'var(--muted)', minWidth: 52, flexShrink: 0, textTransform: 'capitalize' }}>
                              {sub === 'reason' ? 'reason' : sub}{sub === 'draft' ? '?' : ''}
                            </label>
                            <input
                              type="text"
                              value={briefVals[sub]}
                              onChange={(e) => updateBrief({ ...briefVals, [sub]: e.target.value })}
                              style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: '0.82rem' }}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={k} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <code style={{ fontSize: '0.8rem', color: 'var(--accent)', minWidth: 100, flexShrink: 0 }}>{k}</code>
                    <input
                      type="text"
                      value={String(parsed[k] ?? '')}
                      onChange={(e) => {
                        let current: Record<string, unknown> = {};
                        try { current = JSON.parse(testInput) as Record<string, unknown>; } catch { /* ignore */ }
                        current[k] = e.target.value;
                        onTestInputChange(JSON.stringify(current, null, 2));
                      }}
                      style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: '0.82rem' }}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <textarea
              value={testInput}
              onChange={(e) => onTestInputChange(e.target.value)}
              rows={4}
              spellCheck={false}
              style={{ ...textareaStyle, fontFamily: 'monospace', fontSize: '0.82rem' }}
            />
          )}
          <button onClick={onRun} disabled={testRunning} style={{ ...primaryBtn, marginTop: '0.5rem' }}>
            {testRunning ? '⏳ Running…' : '▶ Run Test'}
          </button>
          {flow?.expectedOutput && !testResult && (
            <div style={{ marginTop: '0.75rem', background: 'var(--bg)', border: '1px dashed var(--border)', borderRadius: 6, padding: '0.5rem 0.65rem', fontSize: '0.78rem', color: 'var(--muted)', lineHeight: 1.5 }}>
              <span style={{ fontWeight: 600, color: 'var(--accent)', display: 'block', marginBottom: '0.2rem' }}>Expected output:</span>
              {flow.expectedOutput}
            </div>
          )}
        </div>
        {testResult && (
          <div style={{ flex: 2, minWidth: 280 }}>
            <label style={labelStyle}>
              {testResult.ok ? '✓ Result' : '✗ Error'}
              <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: '0.5rem' }}>({testResult.durationMs}ms)</span>
            </label>
            {testResult.error && (
              <pre style={{ ...preStyle, borderColor: '#f8514933', color: 'var(--error)' }}>{testResult.error}</pre>
            )}
            {testResult.ok && testResult.result && (() => {
              const r = testResult.result;
              const looksLikeHtml = r.includes('<!DOCTYPE') || r.includes('<html') || r.includes('{"html":') || (r.includes('<div') && r.length > 500);
              if (!looksLikeHtml) return null;
              return (
                <div style={{ background: '#f851491a', border: '1px solid #f8514944', borderRadius: 6, padding: '0.6rem 0.75rem', marginBottom: '0.5rem', fontSize: '0.82rem', color: '#f85149' }}>
                  ⚠️ <strong>Output looks like raw HTML</strong> — check that the URL is normalised correctly before the fetch step.
                </div>
              );
            })()}
            {testResult.ok && (
              <pre style={preStyle}>{(() => {
                if (!testResult.result) return 'null';
                try { return JSON.stringify(JSON.parse(testResult.result), null, 2); }
                catch { return testResult.result; }
              })()}</pre>
            )}
            {Object.keys(testResult.stepResults).length > 0 && (
              <>
                <label style={{ ...labelStyle, marginTop: '0.75rem' }}>Step Results</label>
                {steps.map((step) => {
                  const res = testResult.stepResults[step.id];
                  if (res === undefined) return null;
                  const ms = testResult.stepTimings?.[step.id];
                  return (
                    <div key={step.id} style={{ marginBottom: '0.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                        <code style={{ fontSize: '0.78rem', color: 'var(--accent)' }}>{step.label}</code>
                        {ms !== undefined && (
                          <span style={{ fontSize: '0.7rem', color: 'var(--muted)', fontFamily: 'monospace' }}>{ms}ms</span>
                        )}
                      </div>
                      <pre style={{ ...preStyle, marginTop: '0.25rem', maxHeight: 120 }}>{JSON.stringify(res, null, 2)}</pre>
                    </div>
                  );
                })}
              </>
            )}
            {flow?.expectedOutput && (
              <div style={{ marginTop: '0.75rem' }}>
                <label style={{ ...labelStyle, color: 'var(--accent)' }}>Expected Output Contract</label>
                <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.6rem 0.75rem', fontSize: '0.82rem', color: 'var(--muted)', lineHeight: 1.5 }}>
                  {flow.expectedOutput}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
