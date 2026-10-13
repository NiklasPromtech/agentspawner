-- Add per-secret rate limiting: max requests per minute for each API key
ALTER TABLE agent_secrets ADD COLUMN requests_per_minute INTEGER;
