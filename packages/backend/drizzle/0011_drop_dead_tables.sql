-- OPERATION CONVERGENCE: Task 4.5
-- Drop dead tables and columns whose code paths were removed in Tasks 1–4.
--
-- Back up the database before running this on production — these tables contain
-- historical data. The backup is the recovery path; there is no rollback migration.
--
-- What is being removed and why:
--   pending_actions        — Superseded by action_log in OPERATION KEYSTONE.
--                            All code that writes to / reads from this table was
--                            deleted (Task 2). The queue_action / list_pending_actions /
--                            complete_action agent tools have been removed.
--
--   pending_human_reviews  — Legacy __human_review__ flow step was removed in
--                            OPERATION KEYSTONE. No new rows have been written
--                            since then; the read-only UI routes are also deleted.
--
--   paused_step_results    — Added in migration 0007 for the pause/resume flow
--                            machinery that was subsequently removed. Replaced by
--                            step_results (migration 0009) which is the live column.
--
--   paused_at              — Companion column to paused_step_results; equally dead.

DROP TABLE IF EXISTS pending_actions;
DROP TABLE IF EXISTS pending_human_reviews;

ALTER TABLE flow_runs DROP COLUMN paused_step_results;
ALTER TABLE flow_runs DROP COLUMN paused_at;
