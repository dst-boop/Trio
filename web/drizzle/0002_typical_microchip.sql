CREATE TABLE `provider_credentials` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`cipher` text,
	`iv` text,
	`model` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `provider`)
);
