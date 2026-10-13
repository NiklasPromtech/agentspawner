-- OPERATION KEYSTONE: Task 2
-- Add step_results column to flow_runs.
-- Always written on run completion (success, fail, or block).
-- Replaces pausedStepResults as the primary step trace source.

ALTER TABLE flow_runs ADD COLUMN step_results TEXT;
