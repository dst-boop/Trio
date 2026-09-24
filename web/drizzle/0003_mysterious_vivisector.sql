CREATE TABLE `quality_phases` (
	`user_id` text NOT NULL,
	`run_id` text NOT NULL,
	`step` integer NOT NULL,
	`report` text NOT NULL,
	PRIMARY KEY(`user_id`, `run_id`, `step`)
);
--> statement-breakpoint
CREATE TABLE `quality_runs` (
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
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quality_one_active_account` ON `quality_runs` (`user_id`) WHERE "quality_runs"."status" = 'running' OR "quality_runs"."lease" IS NOT NULL;