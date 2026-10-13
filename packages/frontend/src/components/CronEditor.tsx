interface Props {
  value: string;
  onChange: (value: string) => void;
}

const PRESETS = [
  { label: 'Every minute', value: '* * * * *' },
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every day at 9am', value: '0 9 * * *' },
  { label: 'Every weekday at 9am', value: '0 9 * * 1-5' },
  { label: 'Every Monday at 8am', value: '0 8 * * 1' },
];

export default function CronEditor({ value, onChange }: Props) {
  return (
    <div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="* * * * *"
        style={{
          width: '100%',
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          color: 'var(--text)',
          padding: '0.5rem 0.75rem',
          fontSize: '0.9rem',
          fontFamily: 'monospace',
          marginBottom: '0.5rem',
        }}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
        {PRESETS.map((p) => (
          <button
            key={p.value}
            onClick={() => onChange(p.value)}
            style={{
              background: value === p.value ? '#1f6feb33' : 'var(--surface)',
              border: `1px solid ${value === p.value ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 4,
              color: value === p.value ? 'var(--accent)' : 'var(--muted)',
              padding: '0.2rem 0.6rem',
              fontSize: '0.75rem',
              cursor: 'pointer',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.5rem' }}>
        Format: minute hour day month weekday (Europe/Stockholm timezone)
      </p>
    </div>
  );
}
