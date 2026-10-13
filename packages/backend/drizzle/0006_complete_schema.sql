CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`parent_id` text,
	`type` text DEFAULT 'task' NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 3 NOT NULL,
	`due_date` text,
	`notes` text DEFAULT '' NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pending_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`type` text DEFAULT 'other' NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`run_id` text,
	`resolved_at` text,
	`resolved_by` text DEFAULT '' NOT NULL,
	`result` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `performance_log` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`action` text NOT NULL,
	`outcome` text DEFAULT 'unknown' NOT NULL,
	`value` real DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`run_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `api_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`input_schema` text DEFAULT '{"type":"object","properties":{},"required":[]}' NOT NULL,
	`type` text DEFAULT 'script' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `flow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`flow_name` text NOT NULL,
	`agent_id` text NOT NULL,
	`run_id` text,
	`input` text DEFAULT '{}' NOT NULL,
	`output` text,
	`evaluation_passed` integer,
	`evaluation_reason` text,
	`duration_ms` integer,
	`success` integer DEFAULT true NOT NULL,
	`error` text,
	`reasoning` text,
	`goal_id` text,
	`model_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `action_log` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`flow_name` text NOT NULL,
	`flow_type` text NOT NULL,
	`key_field` text NOT NULL,
	`key_value` text NOT NULL,
	`input` text DEFAULT '{}' NOT NULL,
	`result` text,
	`blocked` integer DEFAULT false NOT NULL,
	`run_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`platform` text NOT NULL,
	`handle` text NOT NULL,
	`display_name` text,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'prospect' NOT NULL,
	`last_action` text,
	`last_action_at` text,
	`last_action_input` text DEFAULT '{}' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pending_human_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`flow_run_id` text,
	`flow_name` text NOT NULL,
	`step_id` text NOT NULL,
	`tab_url` text NOT NULL,
	`draft_content` text NOT NULL,
	`content_label` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`final_content` text,
	`rejection_reason` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tone_edits` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`review_id` text NOT NULL,
	`flow_name` text NOT NULL,
	`context` text DEFAULT '' NOT NULL,
	`agent_draft` text NOT NULL,
	`human_final` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `runs` ADD `input_tokens` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `runs` ADD `output_tokens` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `runs` ADD `cost_usd` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `runs` ADD `model_id` text;
--> statement-breakpoint
ALTER TABLE `agents` ADD `tone_guide` text;
--> statement-breakpoint
ALTER TABLE `agents` ADD `tone_guide_updated_at` text;
--> statement-breakpoint
ALTER TABLE `rows` ADD `run_id` text;
--> statement-breakpoint
ALTER TABLE `rows` ADD `flow_run_id` text;
--> statement-breakpoint
ALTER TABLE `flows` ADD `pinned` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `flows` ADD `result_message` text;
--> statement-breakpoint
ALTER TABLE `flows` ADD `flow_type` text;
--> statement-breakpoint
ALTER TABLE `flows` ADD `step_delay_ms` integer;
--> statement-breakpoint
ALTER TABLE `flows` ADD `dedup_key_field` text;
--> statement-breakpoint
ALTER TABLE `flows` ADD `dedup_break_type` text;
--> statement-breakpoint
ALTER TABLE `flows` ADD `dedup_interval_hours` integer;
--> statement-breakpoint
ALTER TABLE `flows` ADD `dedup_block_message` text;
--> statement-breakpoint
ALTER TABLE `flows` ADD `reads_from` text;
--> statement-breakpoint
ALTER TABLE `flows` ADD `writes_to` text;
--> statement-breakpoint
ALTER TABLE `flows` ADD `updates_fields` text;
--> statement-breakpoint
ALTER TABLE `flows` ADD `requires_approval` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `flows` ADD `infeasible` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `flows` ADD `infeasible_reason` text;
--> statement-breakpoint
ALTER TABLE `flows` ADD `requires_human_review` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `flows` ADD `expected_output` text;
