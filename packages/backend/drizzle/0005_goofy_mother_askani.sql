CREATE TABLE `memory` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`entities` text DEFAULT '[]' NOT NULL,
	`source_agent_id` text,
	`source_agent_name` text,
	`source_tool` text,
	`source_url` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`raw_hash` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_raw_hash_unique` ON `memory` (`raw_hash`);