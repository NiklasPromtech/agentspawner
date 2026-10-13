import { useState } from 'react';
import type { FlowStep, Tool } from '../../types/index.js';

// ── Layout constants ──────────────────────────────────────────────────────────

const NODE_W = 200;
const NODE_H = 58;
const VERT_GAP = 38;
const DIAGRAM_W = 460;
const X_CENTER = DIAGRAM_W / 2;
const NODE_X = (DIAGRAM_W - NODE_W) / 2;
const PAD_TOP = 14;

function nodeTop(idx: number): number {
  return PAD_TOP + idx * (NODE_H + VERT_GAP);
}

// ── Step type colours ─────────────────────────────────────────────────────────

interface TypeInfo {
  fillAlpha: string; // CSS colour with transparency
  stroke: string;
  textColor: string;
  badge: string;
}

function getTypeInfo(toolId: string): TypeInfo {
  switch (toolId) {
    case '__evaluate__':
      return {
        fillAlpha: 'rgba(124,58,237,0.12)',
        stroke: 'rgba(124,58,237,0.55)',
        textColor: '#a78bfa',
        badge: '🔍 Evaluate',
      };
    case '__transform__':
      return {
        fillAlpha: 'rgba(251,146,60,0.12)',
        stroke: 'rgba(251,146,60,0.55)',
        textColor: '#fb923c',
        badge: '⚡ Transform',
      };
    case '__hydrate__':
      return {
        fillAlpha: 'rgba(13,148,136,0.12)',
        stroke: 'rgba(13,148,136,0.55)',
        textColor: '#2dd4bf',
        badge: '💧 Hydrate',
      };
    case '__generate__':
      return {
        fillAlpha: 'rgba(217,119,6,0.12)',
        stroke: 'rgba(217,119,6,0.55)',
        textColor: '#fbbf24',
        badge: '✨ Generate',
      };
    default:
      return {
        fillAlpha: 'rgba(56,139,253,0.12)',
        stroke: 'rgba(56,139,253,0.55)',
        textColor: '#58a6ff',
        badge: '🔧 Tool',
      };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function modelShortName(model: string): string {
  if (model.includes('haiku')) return 'haiku';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('opus')) return 'opus';
  return model.slice(0, 8);
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface FlowDiagramProps {
  steps: FlowStep[];
  agentTools: Tool[];
  requiresApproval?: boolean;
  selectedStepId?: string | null;
  onSelectStep?: (stepId: string) => void;
}

export function FlowDiagram({
  steps,
  agentTools,
  requiresApproval,
  selectedStepId,
  onSelectStep,
}: FlowDiagramProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (steps.length === 0) return null;

  const totalH =
    PAD_TOP +
    steps.length * NODE_H +
    (steps.length - 1) * VERT_GAP +
    PAD_TOP;

  // Map stepId → index for resolving step_ref edges
  const stepIdxMap = new Map(steps.map((s, i) => [s.id, i]));

  // Collect step_ref edges (de-duplicated by fromIdx+toIdx pair)
  const seen = new Set<string>();
  const stepRefEdges: Array<{ fromIdx: number; toIdx: number }> = [];
  steps.forEach((step, toIdx) => {
    Object.values(step.inputMapping).forEach((expr) => {
      if (expr.type === 'step_ref') {
        const fromIdx = stepIdxMap.get(expr.stepId);
        if (fromIdx !== undefined && fromIdx !== toIdx) {
          const key = `${fromIdx}→${toIdx}`;
          if (!seen.has(key)) {
            seen.add(key);
            stepRefEdges.push({ fromIdx, toIdx });
          }
        }
      }
    });
  });

  return (
    <div style={{ marginBottom: '0.75rem' }}>
      {/* Collapsible header */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '0 0 0.4rem 0',
          color: 'var(--muted)',
        }}
      >
        <span style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Flow Diagram
        </span>
        <span style={{ fontSize: '0.7rem' }}>{collapsed ? '▶' : '▼'}</span>
      </button>

      {!collapsed && (
        <div
          style={{
            overflowX: 'auto',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg)',
            padding: '0.5rem',
          }}
        >
          <div
            style={{
              position: 'relative',
              width: DIAGRAM_W,
              height: totalH,
              margin: '0 auto',
            }}
          >
            {/* ── SVG layer (arrows only) ─────────────────────────────────── */}
            <svg
              viewBox={`0 0 ${DIAGRAM_W} ${totalH}`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                overflow: 'visible',
              }}
            >
              <defs>
                <marker
                  id="fd-arrow"
                  markerWidth="7"
                  markerHeight="7"
                  refX="3.5"
                  refY="3.5"
                  orient="auto"
                >
                  <path d="M0,1 L6,3.5 L0,6 Z" fill="var(--border)" />
                </marker>
                <marker
                  id="fd-arrow-ref"
                  markerWidth="7"
                  markerHeight="7"
                  refX="3.5"
                  refY="3.5"
                  orient="auto"
                >
                  <path d="M0,1 L6,3.5 L0,6 Z" fill="rgba(88,166,255,0.6)" />
                </marker>
              </defs>

              {/* Main flow: solid arrows between sequential steps */}
              {steps.slice(0, -1).map((_, idx) => {
                const y1 = nodeTop(idx) + NODE_H;
                const y2 = nodeTop(idx + 1);
                return (
                  <line
                    key={`flow-${idx}`}
                    x1={X_CENTER}
                    y1={y1}
                    x2={X_CENTER}
                    y2={y2 - 5}
                    stroke="var(--border)"
                    strokeWidth={1.5}
                    markerEnd="url(#fd-arrow)"
                  />
                );
              })}

              {/* step_ref: dashed curves on the right side */}
              {stepRefEdges.map(({ fromIdx, toIdx }, i) => {
                const rightEdge = NODE_X + NODE_W;
                const x1 = rightEdge;
                const y1 = nodeTop(fromIdx) + NODE_H / 2;
                const x2 = rightEdge;
                const y2 = nodeTop(toIdx) + NODE_H / 2;
                const bulge = 22 + i * 14;
                const cx = rightEdge + bulge;
                const cy = (y1 + y2) / 2;
                return (
                  <path
                    key={`ref-${i}`}
                    d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
                    fill="none"
                    stroke="rgba(88,166,255,0.55)"
                    strokeWidth={1.5}
                    strokeDasharray="5 3"
                    markerEnd="url(#fd-arrow-ref)"
                  />
                );
              })}

              {/* requiresApproval badge on final step */}
              {requiresApproval && steps.length > 0 && (
                <>
                  <rect
                    x={NODE_X + NODE_W + 8}
                    y={nodeTop(steps.length - 1) + NODE_H / 2 - 10}
                    width={52}
                    height={20}
                    rx={4}
                    fill="rgba(227,179,65,0.15)"
                    stroke="rgba(227,179,65,0.45)"
                    strokeWidth={1}
                  />
                  <text
                    x={NODE_X + NODE_W + 34}
                    y={nodeTop(steps.length - 1) + NODE_H / 2 + 4}
                    fontSize="10"
                    fill="#e3b341"
                    textAnchor="middle"
                    fontFamily="system-ui, sans-serif"
                  >
                    ⏸ Review
                  </text>
                </>
              )}
            </svg>

            {/* ── Node layer ─────────────────────────────────────────────── */}
            {steps.map((step, idx) => {
              const info = getTypeInfo(step.toolId);
              const tool = agentTools.find((t) => t.id === step.toolId);
              const isSelected = selectedStepId === step.id;
              const hasCondition = step.condition != null;
              const top = nodeTop(idx);

              return (
                <div
                  key={step.id}
                  onClick={() => onSelectStep?.(step.id)}
                  title={`Step ${idx + 1}: ${step.label}${tool ? ` — ${tool.name}` : ''}`}
                  style={{
                    position: 'absolute',
                    left: NODE_X,
                    top,
                    width: NODE_W,
                    height: NODE_H,
                    borderRadius: 8,
                    border: `1.5px solid ${isSelected ? info.stroke.replace('0.55', '1') : info.stroke}`,
                    background: isSelected
                      ? info.fillAlpha.replace('0.12', '0.24')
                      : info.fillAlpha,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    padding: '4px 10px',
                    boxSizing: 'border-box',
                    overflow: 'hidden',
                    outline: isSelected ? `2px solid ${info.stroke.replace('0.55', '0.9')}` : 'none',
                    outlineOffset: 2,
                    transition: 'border-color 0.1s, background 0.1s, outline 0.1s',
                  }}
                >
                  {/* Top row: step number + badges */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      marginBottom: 2,
                      overflow: 'hidden',
                    }}
                  >
                    <span
                      style={{
                        fontSize: '0.68rem',
                        color: 'var(--muted)',
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      {idx + 1}
                    </span>

                    {/* Type badge */}
                    <span
                      style={{
                        fontSize: '0.62rem',
                        color: info.textColor,
                        background: info.fillAlpha,
                        border: `1px solid ${info.stroke}`,
                        borderRadius: 3,
                        padding: '0 3px',
                        flexShrink: 0,
                        lineHeight: '1.5',
                      }}
                    >
                      {info.badge}
                    </span>

                    {/* Condition badge */}
                    {hasCondition && (
                      <span
                        style={{
                          fontSize: '0.62rem',
                          color: '#e3b341',
                          background: 'rgba(227,179,65,0.12)',
                          border: '1px solid rgba(227,179,65,0.4)',
                          borderRadius: 3,
                          padding: '0 3px',
                          flexShrink: 0,
                          lineHeight: '1.5',
                        }}
                      >
                        ◆ cond
                      </span>
                    )}

                    {/* stepModel badge */}
                    {step.stepModel && (
                      <span
                        style={{
                          fontSize: '0.62rem',
                          color: 'var(--muted)',
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 3,
                          padding: '0 3px',
                          flexShrink: 0,
                          lineHeight: '1.5',
                        }}
                      >
                        {modelShortName(step.stepModel)}
                      </span>
                    )}
                  </div>

                  {/* Step label */}
                  <span
                    style={{
                      fontSize: '0.78rem',
                      color: 'var(--text)',
                      fontWeight: 500,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      lineHeight: 1.3,
                    }}
                  >
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
