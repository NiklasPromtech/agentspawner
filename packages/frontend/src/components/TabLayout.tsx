import type { ReactNode, CSSProperties } from 'react';

// ─── Sub-component types ───────────────────────────────────────────────────

export interface TabAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}

export interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  actions?: TabAction[];
}

interface TabLayoutProps {
  /** Tab heading */
  title: string;
  /** Optional sub-heading shown below the title */
  description?: string;
  /** Buttons rendered in the top-right of the header */
  actions?: TabAction[];
  /** Pass true to show a loading spinner instead of children */
  loading?: boolean;
  /** Pass an error string to show an error banner; optionally supply onRetry */
  error?: string | null;
  onRetry?: () => void;
  /** Empty-state config. Rendered when children is omitted or `isEmpty` is true */
  emptyState?: EmptyStateProps;
  isEmpty?: boolean;
  /** Max content width (default 760) */
  maxWidth?: number | string;
  /** Extra style applied to the outer wrapper */
  style?: CSSProperties;
  children?: ReactNode;
}

// ─── Spinner ──────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '4rem',
      color: 'var(--muted)',
    }}>
      <svg
        width="24" height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ animation: 'tab-spin 0.8s linear infinite' }}
      >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <style>{`@keyframes tab-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── Error banner ─────────────────────────────────────────────────────────

function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div style={{
      background: 'rgba(248,81,73,0.08)',
      border: '1px solid rgba(248,81,73,0.35)',
      borderRadius: 8,
      padding: '0.875rem 1rem',
      display: 'flex',
      alignItems: 'center',
      gap: '0.75rem',
      marginBottom: '1.25rem',
    }}>
      <span style={{ fontSize: '1rem', flexShrink: 0 }}>⚠</span>
      <span style={{ flex: 1, fontSize: '0.875rem', color: '#f85149', lineHeight: 1.4 }}>{message}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            background: 'transparent',
            border: '1px solid rgba(248,81,73,0.4)',
            borderRadius: 5,
            color: '#f85149',
            fontSize: '0.8rem',
            padding: '0.3rem 0.75rem',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────

function EmptyState({ icon, title, description, actions }: EmptyStateProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      textAlign: 'center',
      padding: '4rem 2rem',
      color: 'var(--muted)',
    }}>
      {icon && <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem', lineHeight: 1 }}>{icon}</div>}
      <p style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.4rem' }}>{title}</p>
      {description && (
        <p style={{ fontSize: '0.875rem', maxWidth: 420, lineHeight: 1.6, marginBottom: actions && actions.length > 0 ? '1.25rem' : 0 }}>
          {description}
        </p>
      )}
      {actions && actions.length > 0 && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          {actions.map((a, i) => (
            <button
              key={i}
              onClick={a.onClick}
              disabled={a.disabled}
              style={actionButtonStyle(a.variant ?? 'secondary')}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Action button style helper ───────────────────────────────────────────

function actionButtonStyle(variant: 'primary' | 'secondary' | 'danger'): CSSProperties {
  const base: CSSProperties = {
    border: 'none',
    borderRadius: 6,
    fontSize: '0.875rem',
    fontWeight: 600,
    padding: '0.45rem 1.1rem',
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  };
  if (variant === 'primary') return { ...base, background: '#238636', color: '#fff' };
  if (variant === 'danger')  return { ...base, background: 'transparent', border: '1px solid #f85149', color: '#f85149' };
  // secondary
  return { ...base, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' };
}

// ─── TabLayout ────────────────────────────────────────────────────────────

export default function TabLayout({
  title,
  description,
  actions,
  loading = false,
  error,
  onRetry,
  emptyState,
  isEmpty = false,
  maxWidth = 760,
  style,
  children,
}: TabLayoutProps) {
  return (
    <div style={{ padding: '1.5rem', maxWidth, ...style }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: description ? 'flex-start' : 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        marginBottom: '1.5rem',
      }}>
        <div>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>{title}</h3>
          {description && (
            <p style={{ fontSize: '0.82rem', color: 'var(--muted)', margin: '0.25rem 0 0', lineHeight: 1.5 }}>
              {description}
            </p>
          )}
        </div>
        {actions && actions.length > 0 && (
          <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
            {actions.map((a, i) => (
              <button
                key={i}
                onClick={a.onClick}
                disabled={a.disabled}
                style={actionButtonStyle(a.variant ?? 'primary')}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && <ErrorBanner message={error} onRetry={onRetry} />}

      {/* Body */}
      {loading ? (
        <Spinner />
      ) : isEmpty && emptyState ? (
        <EmptyState {...emptyState} />
      ) : (
        children
      )}
    </div>
  );
}

// Re-export helpers so tabs can use them if needed
export { EmptyState, ErrorBanner, Spinner, actionButtonStyle };
