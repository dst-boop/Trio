CREATE TABLE `workspace_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`demo` integer DEFAULT 1 NOT NULL,
	`mode` text DEFAULT 'single' NOT NULL,
	`lead` text DEFAULT 'openai' NOT NULL
);
