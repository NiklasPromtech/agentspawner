-- OPERATION CONVERGENCE: Task 7
-- Add tone refresh error tracking columns to agents table.
--
-- Purpose: surfacing tone learning loop failures to the user instead of
-- silently swallowing them in server logs.
--
--   tone_refresh_error     — last error message from refreshToneGuide(); null when last refresh succeeded
--   tone_refresh_error_at  — ISO timestamp of that error; null when last refresh succeeded

ALTER TABLE agents ADD COLUMN tone_refresh_error TEXT;
ALTER TABLE agents ADD COLUMN tone_refresh_error_at TEXT;
