import { useState, useEffect } from 'react';
import { api } from '../../api/client.js';
import type { Agent, Table, Row } from '../../types/index.js';

interface Props {
  agent: Agent;
}

export default function DatabaseTab({ agent }: Props) {
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedTable, setSelectedTable] = useState<Table | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTableName, setNewTableName] = useState('');

  useEffect(() => {
    api.getTables(agent.id).then(setTables).catch(console.error).finally(() => setLoading(false));
  }, [agent.id]);

  const handleSelectTable = async (table: Table) => {
    setSelectedTable(table);
    setRowsLoading(true);
    try {
      const r = await api.getRows(table.id);
      setRows(r);
    } catch (err) {
      console.error(err);
    } finally {
      setRowsLoading(false);
    }
  };

  const handleCreateTable = async () => {
    if (!newTableName.trim()) return;
    try {
      const t = await api.createTable(agent.id, { name: newTableName.trim(), columns: '[]' });
      setTables((prev) => [...prev, t]);
      setCreating(false);
      setNewTableName('');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create table');
    }
  };

  const handleDeleteRow = async (row: Row) => {
    if (!selectedTable) return;
    await api.deleteRow(selectedTable.id, row.id);
    setRows((prev) => prev.filter((r) => r.id !== row.id));
  };

  const handleDeleteTable = async (table: Table) => {
    if (!confirm(`Delete table "${table.name}" and all its rows?`)) return;
    await api.deleteTable(agent.id, table.id);
    setTables((prev) => prev.filter((t) => t.id !== table.id));
    if (selectedTable?.id === table.id) { setSelectedTable(null); setRows([]); }
  };

  // Derive columns from first row
  const columns = rows.length > 0 ? Object.keys(JSON.parse(rows[0]!.data)) : [];

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 100px)' }}>
      {/* ── Table list (sidebar) ─────────────────────────────── */}
      <div style={{
        width: 220,
        borderRight: '1px solid var(--border)',
        padding: '1rem',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Tables</span>
          <button
            onClick={() => setCreating(true)}
            title="Create table"
            style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: '1.1rem', cursor: 'pointer', lineHeight: 1, padding: '0 0.1rem' }}
          >
            +
          </button>
        </div>

        {creating && (
          <div style={{ marginBottom: '0.75rem' }}>
            <input
              autoFocus
              value={newTableName}
              onChange={(e) => setNewTableName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateTable(); if (e.key === 'Escape') setCreating(false); }}
              placeholder="table_name"
              style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: 4, color: 'var(--text)', padding: '0.3rem 0.5rem', fontSize: '0.85rem', boxSizing: 'border-box' }}
            />
          </div>
        )}

        {loading ? (
          <p style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>Loading…</p>
        ) : tables.length === 0 && !creating ? (
          <div style={{ marginTop: '1rem', textAlign: 'center' }}>
            <p style={{ fontSize: '0.8rem', color: 'var(--muted)', lineHeight: 1.5 }}>
              No tables yet.<br />Click <strong style={{ color: 'var(--accent)' }}>+</strong> to create one.
            </p>
          </div>
        ) : (
          tables.map((t) => (
            <div
              key={t.id}
              onClick={() => void handleSelectTable(t)}
              style={{
                padding: '0.4rem 0.5rem',
                borderRadius: 6,
                cursor: 'pointer',
                background: selectedTable?.id === t.id ? 'var(--surface)' : 'transparent',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '0.15rem',
              }}
            >
              <span style={{ fontSize: '0.875rem', color: selectedTable?.id === t.id ? 'var(--accent)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.name}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); void handleDeleteTable(t); }}
                title="Delete table"
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '0.85rem', cursor: 'pointer', flexShrink: 0 }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      {/* ── Table content ────────────────────────────────────── */}
      <div style={{ flex: 1, padding: '1.25rem', overflowY: 'auto' }}>
        {!selectedTable ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem', lineHeight: 1 }}>🗄️</div>
            <p style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.4rem' }}>
              {tables.length === 0 ? 'No tables yet' : 'Select a table'}
            </p>
            <p style={{ fontSize: '0.875rem', maxWidth: 380, lineHeight: 1.6 }}>
              {tables.length === 0
                ? 'Tables are populated automatically when the agent uses database tools. You can also create one manually using the + button.'
                : 'Choose a table from the left to view and manage its rows.'}
            </p>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>{selectedTable.name}</h3>
              <span style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>{rows.length} row{rows.length !== 1 ? 's' : ''}</span>
            </div>

            {rowsLoading ? (
              <p style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>Loading rows…</p>
            ) : rows.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--muted)' }}>
                <p style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.4rem' }}>Table is empty</p>
                <p style={{ fontSize: '0.875rem', lineHeight: 1.6 }}>
                  This table will be populated when the agent uses it during a flow run.
                </p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                  <thead>
                    <tr>
                      {columns.map((col) => (
                        <th key={col} style={{ textAlign: 'left', padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border)', color: 'var(--muted)', fontWeight: 600 }}>
                          {col}
                        </th>
                      ))}
                      <th style={{ textAlign: 'left', padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border)', color: 'var(--muted)', fontWeight: 600 }}>Created</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const data = JSON.parse(row.data) as Record<string, unknown>;
                      return (
                        <tr key={row.id} style={{ borderBottom: '1px solid var(--border)' }}>
                          {columns.map((col) => (
                            <td key={col} style={{ padding: '0.5rem 0.75rem', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {String(data[col] ?? '')}
                            </td>
                          ))}
                          <td style={{ padding: '0.5rem 0.75rem', color: 'var(--muted)', fontSize: '0.8rem' }}>
                            {new Date(row.createdAt).toLocaleString()}
                          </td>
                          <td style={{ padding: '0.5rem 0.75rem' }}>
                            <button onClick={() => void handleDeleteRow(row)} style={{ background: 'transparent', border: 'none', color: 'var(--error)', cursor: 'pointer', fontSize: '0.8rem' }}>
                              Delete
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
