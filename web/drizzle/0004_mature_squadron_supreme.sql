CREATE TABLE `work_comparison_phases` (
	`user_id` text NOT NULL,
	`run_id` text NOT NULL,
	`step` integer NOT NULL,
	`report` text NOT NULL,
	PRIMARY KEY(`user_id`, `run_id`, `step`)
);
--> statement-breakpoint
CREATE TABLE `work_comparison_runs` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`status` text NOT NULL,
	`config` text NOT NULL,
	`started_at` integer NOT NULL,
	`deadline` integer NOT NULL,
	`finished_at` integer,
	`cursor` integer DEFAULT 0 NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`lease` text,
	`lease_until` integer,
	`blind_seed` text NOT NULL,
	`ratings` text,
	`rated_at` integer,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_comparison_one_active_account` ON `work_comparison_runs` (`user_id`) WHERE "work_comparison_runs"."status" = 'running' OR "work_comparison_runs"."lease" IS NOT NULL;