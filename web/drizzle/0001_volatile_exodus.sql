CREATE TABLE `personal_memory` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL
);
