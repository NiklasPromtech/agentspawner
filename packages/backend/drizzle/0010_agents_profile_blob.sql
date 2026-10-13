-- OPERATION KEYSTONE: Task 3
-- Add profile_blob and profile_blob_updated_at columns to agents.
-- Stores structured setup output (job description, competitors, tone, etc.)
-- alongside the raw system_prompt for use in the Setup dashboard view.

ALTER TABLE agents ADD COLUMN profile_blob TEXT;
ALTER TABLE agents ADD COLUMN profile_blob_updated_at TEXT;
