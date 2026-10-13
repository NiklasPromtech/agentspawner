-- OPERATION CONVERGENCE Task 10: agent activity status tracking
-- Adds status and last_active_at to agents so the dashboard can show live state
-- without a full run query on every poll.

ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE agents ADD COLUMN last_active_at TEXT;
