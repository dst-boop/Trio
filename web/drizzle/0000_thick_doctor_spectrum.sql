CREATE TABLE `workspace_chunks` (
	`user_id` text NOT NULL,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	PRIMARY KEY(`user_id`, `position`),
	FOREIGN KEY (`user_id`) REFERENCES `workspaces`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`token` text NOT NULL
);
