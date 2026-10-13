-- Fix wait_ms tool: move from extension to builtin so it runs server-side
-- without requiring the content script to be injected first.
-- This allows wait_ms to be used as a post-open_tab buffer before DOM steps.
UPDATE tools
SET tool_type = 'builtin', code = 'wait_ms'
WHERE name = 'wait_ms' AND tool_type = 'extension';
