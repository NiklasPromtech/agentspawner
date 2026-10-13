ALTER TABLE `action_log` ADD `status` text NOT NULL DEFAULT 'executed';
--> statement-breakpoint
ALTER TABLE `action_log` ADD `blocked_reason` text;
--> statement-breakpoint
ALTER TABLE `action_log` ADD `final_content` text;
--> statement-breakpoint
ALTER TABLE `action_log` ADD `re_run_count` integer NOT NULL DEFAULT 0;
